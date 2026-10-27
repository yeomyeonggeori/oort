import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import * as ts from 'typescript';
import { DEFAULT_THEME_CHOICE } from '../src/design/theme';
import { lightPalette } from '../src/design/tokens';
import { NSE_KEYCHAIN_ACCESS_GROUP } from '../src/storage/secureSession';

// =============================================================================
// Mechanical guards for the decisions this project cannot afford to lose by
// accident. Every assertion here stands in for a specific, documented way this
// scaffold has already been destroyed once — in this product's own research, or
// in the project (Tauri) that lost the same fight.
//
// These are cheap and they are file-shaped rather than behavioural on purpose:
// the failures they catch are silent, and by the time a behavioural test could
// see them the artifact is already gone.
//
// `npm run gate:project-shape` runs this file alone, for CI.
// =============================================================================

const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '../..');
const PBXPROJ = join(APP_ROOT, 'ios/MomoMobile.xcodeproj/project.pbxproj');

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// Source with its comments removed, for the guards below that search code for a
// banned name. Comments name those APIs constantly (that is where the reasons
// live), so a search that kept them would drown.
//
// The TypeScript parser does the removing, not a pattern. A pattern cannot tell
// a comment from code: `/\/\*[\s\S]*?\*\//` applied first let the `/*` inside a
// `//` comment (`**/v1/**` in the core's chainModel.ts) swallow the 37 lines of
// real code that followed, and a banned call written there passed every guard
// (review of #2587). Stripping `//` first has the mirror bug — `//` inside a
// string, a template literal or a regex. The parser knows where each of those
// ends, so only real comments go. The printer re-spaces the code, which the
// patterns below tolerate (`\s*`); identifiers and literals are unchanged.
const commentFreePrinter = ts.createPrinter({ removeComments: true });
function stripComments(fileName: string, source: string): string {
  const kind = fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
    ? ts.ScriptKind.JSX
    : fileName.endsWith('.js')
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
  // setParentNodes=true: the printer keeps a string literal's original quotes
  // only when it can walk up to the source file.
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  return commentFreePrinter.printFile(sf);
}
const codeCache = new Map<string, string>();
function codeOf(file: string): string {
  let code = codeCache.get(file);
  if (code === undefined) {
    code = stripComments(file, readFileSync(file, 'utf8'));
    codeCache.set(file, code);
  }
  return code;
}

describe('comment removal used by the code guards (review of #2587)', () => {
  it('removes comments without swallowing the code around them', () => {
    const source = [
      '// catch-all: **/v1/** answers {}',
      'const a = createMMKV({encryptionKey: k});',
      "/* block naming window.x */ const s = '/* in a string */';",
      "const u = 'https://example.com//x';",
      'const t = `${host}//path/*.ts`; const b = crypto.subtle;',
      'const r = /^https?:\\/\\//; const c = x.encrypt(y);',
      '/** jsdoc naming fetch( */',
      'export const tail = 1; // trailing, names recrypt(',
    ].join('\n');
    const code = stripComments('probe.ts', source);
    // Code after each tricky construct survives …
    for (const kept of [
      'encryptionKey',
      "'/* in a string */'",
      "'https://example.com//x'",
      '`${host}//path/*.ts`',
      'crypto.subtle',
      'x.encrypt(y)',
      'export const tail = 1;',
    ]) {
      expect(code).toContain(kept);
    }
    // … and the comments are gone.
    for (const dropped of [
      'catch-all',
      'window.x',
      'jsdoc naming',
      'trailing, names',
    ]) {
      expect(code).not.toContain(dropped);
    }
  });
});

// Swift source with its comments AND string text removed, for the allowlist guard on the one
// file that hashes (#3931). Code inside a string interpolation (`"\(SHA256.hash(...))"`) is
// code and stays; the words inside a string or a comment are not code and go. A pattern cannot
// do this (a `//` inside a string, a `"` inside an interpolation, a nested block comment, a raw
// `#"…"#` string), the same way it could not for TypeScript above, so this is a small scanner.
function swiftCode(source: string): string {
  let i = 0;
  let out = '';

  const rawHashesAt = (at: number): number => {
    let n = 0;
    while (source[at + n] === '#') n += 1;
    return source[at + n] === '"' ? n : -1;
  };

  // `i` is on the opening delimiter (any number of `#`, then `"` or three of them). Leaves `i`
  // after the closing one.
  const skipString = (): void => {
    const hashes = rawHashesAt(i);
    i += hashes;
    const multiline = source.startsWith('"""', i);
    i += multiline ? 3 : 1;
    const closer = (multiline ? '"""' : '"') + '#'.repeat(hashes);
    while (i < source.length) {
      if (source.startsWith(closer, i)) {
        i += closer.length;
        return;
      }
      if (source[i] === '\\' && source.startsWith('#'.repeat(hashes), i + 1)) {
        const after = i + 1 + hashes;
        if (source[after] === '(') {
          // Interpolation: the expression is code.
          i = after + 1;
          out += ' (';
          scanCode(true);
          out += ') ';
          continue;
        }
        i = after + 1; // an escaped character
        continue;
      }
      i += 1;
    }
  };

  const skipBlockComment = (): void => {
    let depth = 0;
    while (i < source.length) {
      if (source.startsWith('/*', i)) {
        depth += 1;
        i += 2;
      } else if (source.startsWith('*/', i)) {
        depth -= 1;
        i += 2;
        if (depth === 0) return;
      } else {
        i += 1;
      }
    }
  };

  // With `untilParen`, returns at the `)` that closes the interpolation (leaving `i` after it).
  const scanCode = (untilParen: boolean): void => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && source[i + 1] === '*') {
        skipBlockComment();
        out += ' ';
        continue;
      }
      if (c === '"' || (c === '#' && rawHashesAt(i) >= 0)) {
        skipString();
        out += '""';
        continue;
      }
      // An extended regex literal `#/…/#` (any number of `#`): its body may hold `//` or a
      // quote, which would otherwise be taken for a comment or a string and hide the code after it.
      if (c === '#') {
        let hashes = 0;
        while (source[i + hashes] === '#') hashes += 1;
        if (source[i + hashes] === '/') {
          const closer = '/' + '#'.repeat(hashes);
          i += hashes + 1;
          while (i < source.length && !source.startsWith(closer, i)) i += 1;
          i += closer.length;
          out += '/**/';
          continue;
        }
      }
      if (untilParen) {
        if (c === '(') depth += 1;
        if (c === ')') {
          if (depth === 0) {
            i += 1;
            return;
          }
          depth -= 1;
        }
      }
      out += c;
      i += 1;
    }
  };

  scanCode(false);
  return out;
}

describe('Swift comment and string removal used by the export-compliance guard (#3931)', () => {
  it('drops comments and string text, keeps code, including code inside an interpolation', () => {
    const source = [
      '// import CommonCrypto and CCHmac, named in a line comment',
      '/* AES.GCM.seal /* nested */ still a comment: HKDF */',
      'import CryptoKit',
      'let url = "https://example.com//AES/*not a comment*/"',
      'let raw = #"a "quoted" HMAC and \\#(SHA256.hash(data: d))"#',
      'let text = """',
      '  multi-line ChaChaPoly',
      '  """',
      'let shown = "digest \\(SymmetricKey(size: .bits256)) end"',
      'let tail = hash(data) // trailing HKDF',
    ].join('\n');
    const code = swiftCode(source);
    for (const kept of ['import CryptoKit', 'SHA256.hash(data: d)', 'SymmetricKey(size: .bits256)', 'let tail = hash(data)']) {
      expect(code).toContain(kept);
    }
    for (const dropped of ['CommonCrypto', 'CCHmac', 'AES', 'nested', 'HKDF', 'ChaChaPoly', 'quoted', 'HMAC', 'example.com']) {
      expect(code).not.toContain(dropped);
    }
  });

  it('does not let a quote inside an interpolation or a comment marker inside a string end the scan early', () => {
    const code = swiftCode(
      ['let a = "x \\(f("y // z")) w"', 'let b = "/* open"', 'let c = AES.GCM.seal(m)'].join('\n'),
    );
    expect(code).toContain('f(""');
    expect(code).toContain('let c = AES.GCM.seal(m)');
  });

  it('does not let a regex literal hide the code after it', () => {
    const code = swiftCode(
      ['let r = #/a//b"/#; let c = AES.GCM.seal(m)', 'let q = ##/x/#y/##; import CommonCrypto'].join('\n'),
    );
    expect(code).toContain('let c = AES.GCM.seal(m)');
    expect(code).toContain('import CommonCrypto');
  });
});

describe('the iOS project survives (ADR-0137 D7 정오 7항)', () => {
  it('still has its Xcode project', () => {
    // `expo prebuild` without `--platform android` REGENERATES ios/. One run is
    // enough to delete the NSE target that 이행 순서 5 attaches here — literally
    // the accident that killed the Tauri path (#15663). Nothing in this project
    // may invoke it.
    expect(existsSync(PBXPROJ)).toBe(true);
    expect(existsSync(join(APP_ROOT, 'ios/Podfile'))).toBe(true);
    expect(existsSync(join(APP_ROOT, 'ios/MomoMobile/AppDelegate.swift'))).toBe(
      true,
    );
  });

  it('has no script that could run prebuild', () => {
    const pkg = JSON.parse(
      readFileSync(join(APP_ROOT, 'package.json'), 'utf8'),
    );
    for (const [name, script] of Object.entries<string>(pkg.scripts)) {
      expect(`${name}: ${script}`).not.toContain('prebuild');
    }
  });
});

describe('the Xcode Cloud lane stays reachable (#1115, docs/cicd/10 §8)', () => {
  // Every assertion here is a way this lane breaks WITHOUT breaking any build:
  // Xcode Cloud simply stops running, or runs and skips the bootstrap, and the
  // only symptom is a PR check that quietly went missing. None of it is
  // observable from a local build, which is why it is file-shaped.
  const IOS = join(APP_ROOT, 'ios');
  const tracked = (path: string) =>
    execSync(`git ls-files -s -- ${JSON.stringify(path)}`, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();

  it('keeps both ci_scripts executable in the index', () => {
    // Xcode Cloud EXECUTES these files; it does not `bash` them. A file
    // committed 100644 is found, skipped, and the build proceeds straight to
    // xcodebuild with no node_modules — failing deep inside the Podfile with a
    // message about CocoaPods. Checking git's mode rather than the working
    // tree's is the point: a chmod that never got committed looks fine locally.
    for (const script of ['ci_post_clone.sh', 'ci_post_xcodebuild.sh']) {
      const entry = tracked(`clients/mobile/ios/ci_scripts/${script}`);
      expect(entry).not.toBe('');
      expect(entry.split(' ')[0]).toBe('100755');
    }
  });

  it('keeps ci_scripts beside the workspace, not at the repo root', () => {
    // Xcode Cloud reads ci_scripts/ from the directory holding the project or
    // workspace it was pointed at. In a monorepo that is this directory, and a
    // copy anywhere else is silently ignored.
    expect(existsSync(join(IOS, 'ci_scripts/ci_post_clone.sh'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'ci_scripts'))).toBe(false);
  });

  it('commits the workspace file, and only that file', () => {
    // The workflow-creation screen offers what is IN THE CLONE. An ignored
    // workspace cannot be selected at all. The rest of the bundle is IDE state
    // and must stay ignored — see clients/mobile/.gitignore for both halves.
    expect(
      tracked(
        'clients/mobile/ios/MomoMobile.xcworkspace/contents.xcworkspacedata',
      ),
    ).not.toBe('');
    const ignored = (path: string) => {
      try {
        execSync(`git check-ignore -q -- ${JSON.stringify(path)}`, {
          cwd: REPO_ROOT,
          stdio: 'pipe',
        });
        return true;
      } catch {
        return false;
      }
    };
    expect(
      ignored(
        'clients/mobile/ios/MomoMobile.xcworkspace/xcshareddata/WorkspaceSettings.xcsettings',
      ),
    ).toBe(true);
    expect(ignored('clients/mobile/ios/Pods/Pods.xcodeproj')).toBe(true);
  });

  it('pins no signing identity in the project file', () => {
    // The RN template left `CODE_SIGN_IDENTITY[sdk=iphoneos*] = "iPhone
    // Developer"` on the Release configuration too. Apple-managed signing
    // expects the default; a project-level override is a development identity
    // nailed into a distribution archive, and local gates never exercise it
    // (they all pass CODE_SIGNING_ALLOWED=NO or CODE_SIGN_IDENTITY=-).
    expect(readFileSync(PBXPROJ, 'utf8')).not.toContain('CODE_SIGN_IDENTITY');
  });

  it('pins node at the floor package.json declares', () => {
    // Two files, one number: ci_post_clone.sh reads .node-version as the
    // minimum, so a drift between them would let CI accept a Node this app
    // says it does not run on.
    const pin = readFileSync(join(APP_ROOT, '.node-version'), 'utf8').trim();
    const pkg = JSON.parse(
      readFileSync(join(APP_ROOT, 'package.json'), 'utf8'),
    );
    expect(pkg.engines.node).toBe(`>= ${pin}`);
  });
});

describe('Android is on hold, not half-started (성재 결정 6)', () => {
  it('has no android directory', () => {
    expect(existsSync(join(APP_ROOT, 'android'))).toBe(false);
  });

  it('has no android build script', () => {
    const pkg = JSON.parse(
      readFileSync(join(APP_ROOT, 'package.json'), 'utf8'),
    );
    expect(Object.keys(pkg.scripts)).not.toContain('android');
  });
});

describe('EAS is not adopted (ADR-0137 D1)', () => {
  it('has no eas.json', () => {
    // momo already owns fastlane + match + `momo-signing`. Moving to EAS would
    // mean rebuilding that, and binding a self-hosted open-source product's
    // builds to one SaaS.
    expect(existsSync(join(APP_ROOT, 'eas.json'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'eas.json'))).toBe(false);
  });

  it('has no Expo config-plugin manifest', () => {
    expect(existsSync(join(APP_ROOT, 'app.config.js'))).toBe(false);
    expect(existsSync(join(APP_ROOT, 'app.config.ts'))).toBe(false);
  });
});

describe('the push inheritance identifiers match the Portal (ADR-0137 D7)', () => {
  const pbxproj = existsSync(PBXPROJ) ? readFileSync(PBXPROJ, 'utf8') : '';

  it('uses the bundle id the App ID and its capabilities already exist under', () => {
    // Every debug and release configuration, not just one: a mismatch that only
    // shows up in the release config is found at submission time.
    expect(pbxproj).toContain('PRODUCT_BUNDLE_IDENTIFIER = app.momo.ios;');
    expect(pbxproj).not.toContain('org.reactjs.native.example');
    const configurations = pbxproj.match(
      /PRODUCT_BUNDLE_IDENTIFIER = app\.momo\.ios;/g,
    );
    expect(configurations?.length).toBe(2);
  });

  it('carries the notification extension under its own App ID', () => {
    // Added by 이행 순서 5. The extension's bundle id must EXTEND the app's, and
    // it needs its own App ID and profile — an app that embeds an extension is
    // signed twice, not once. Both already exist in the Portal.
    const nse = pbxproj.match(
      /PRODUCT_BUNDLE_IDENTIFIER = app\.momo\.ios\.NotificationService;/g,
    );
    expect(nse?.length).toBe(2);
    expect(pbxproj).toContain(
      'productType = "com.apple.product-type.app-extension"',
    );
    // Embedded, not merely built. Without this phase the .appex is produced and
    // then left on the floor, and the app ships with no extension at all — a
    // build that succeeds and a feature that is absent.
    expect(pbxproj).toContain('name = "Embed Foundation Extensions"');
  });

  it('is signed by the team that owns those capabilities', () => {
    expect(pbxproj).toContain('DEVELOPMENT_TEAM = YWQQFQM38J;');
    // Four, not two: two targets (app + notification extension) x two
    // configurations. The count is the point — a target that quietly loses its
    // team keeps building locally and stops being signable in CI.
    expect(pbxproj.match(/DEVELOPMENT_TEAM = YWQQFQM38J;/g)?.length).toBe(4);
  });

  it('registers both invite URL schemes', () => {
    const plist = readFileSync(
      join(APP_ROOT, 'ios/MomoMobile/Info.plist'),
      'utf8',
    );
    expect(plist).toContain('<string>oort</string>');
    expect(plist).toContain('<string>momo</string>');
  });

  it('keeps ATS open for local networking only', () => {
    const plist = readFileSync(
      join(APP_ROOT, 'ios/MomoMobile/Info.plist'),
      'utf8',
    );
    expect(plist).toMatch(/NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    // The switch that requires justification at review stays off.
    expect(plist).toMatch(/NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
  });
});

describe('boot order (spike #837 gate 2)', () => {
  const entry = readFileSync(join(APP_ROOT, 'index.js'), 'utf8');
  const imports = [
    ...entry.matchAll(/^import\s+(?:.*\s+from\s+)?['"](.+)['"];/gm),
  ].map(m => m[1]);

  it('installs the URL polyfill before anything else', () => {
    // A module that captured `URL` at import time would keep React Native's
    // regex version, and every invite link would silently resolve to null.
    expect(imports[0]).toBe('./src/boot/polyfills');
  });

  it('installs the core host before the app tree', () => {
    expect(imports[1]).toBe('./src/boot/coreHost');
    expect(imports.indexOf('./App')).toBeGreaterThan(1);
  });
});

describe('spike constraint 2 — the timeline is not inverted', () => {
  it('has no `inverted` list anywhere in src', () => {
    // Gate 5, real device: with `inverted`, a message arriving while the reader
    // was scrolled back moved their position 46–91px. Forward measured 0px.
    // This guard exists now, before the list is written, because adding
    // `inverted` is the default thing to reach for when building a chat view.
    const offenders = sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx')])
      .filter(file => /\binverted\b/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('DOM is in `lib`, so the discipline is enforced by a gate', () => {
  it('never touches a browser-only global', () => {
    // `tsconfig.json` includes the DOM lib, because React Native genuinely has
    // `fetch`, `Headers`, `AbortController`, `WebSocket` and — once
    // `src/boot/polyfills.ts` has run — a WHATWG `URL`. It also has to, because
    // React Native's own declaration of `URL` has a `readonly hash` that the
    // core's `urlWithoutJoinParams` cannot compile against, and TypeScript
    // cannot relax a `readonly` through declaration merging (TS2687).
    //
    // The cost is that DOM also declares `document`, `window` and
    // `localStorage`, none of which exist here. Rather than accept a type system
    // that would wave those through, they are banned mechanically — the same
    // trade `@momo/core` makes, which stays pure via a gate and not via a `lib`
    // setting.
    const banned =
      /\b(document|localStorage|sessionStorage)\b|\bwindow\.|\bnavigator\.|\blocation\.href\b/;
    const offenders = sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx'), join(APP_ROOT, 'index.js')])
      .filter(file => {
        // Comments discuss these globals by name constantly; a text search
        // that did not strip them would drown, then get tuned until it caught
        // nothing. Same reasoning the core's purity gate gives for parsing.
        const source = codeOf(file)
          // Module specifiers and UI copy are values, not global reads. Without
          // stripping strings, `expo-document-picker` is mistaken for the DOM
          // `document` global even though the source never evaluates it.
          .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '')
          // `Paths.document` 는 expo-file-system 의 앱 샌드박스 Documents 디렉터리다(DOM
          // `document` 전역이 아니다). 내 사진 배경이 OS 가 비우는 캐시 대신 여기에 둔다.
          .replace(/\bPaths\.document\b/g, '');
        return banned.test(source);
      });
    expect(offenders).toEqual([]);
  });
});

describe('the NSE seam stays aligned with the Swift side', () => {
  it('names the access group PushNotification.swift reads', () => {
    expect(NSE_KEYCHAIN_ACCESS_GROUP).toBe('app.momo.ios.shared');
  });

  it('is applied now that the entitlement exists (이행 순서 5)', () => {
    // The constant used to be declared and unused, because applying
    // kSecAttrAccessGroup without a matching entitlement fails -34018 on device
    // only. The entitlement landed with this batch, so the constant must
    // actually be consumed — an unused one would pass the assertion above
    // forever while nothing shared anything.
    const consumers = sourceFiles(join(APP_ROOT, 'src')).filter(
      file =>
        !file.endsWith('secureSession.ts') &&
        /NSE_KEYCHAIN_ACCESS_GROUP/.test(readFileSync(file, 'utf8')),
    );
    expect(consumers).not.toEqual([]);
  });

  it('writes the fetch session under the account the extension reads', () => {
    // The full string-by-string comparison against the Swift source lives in
    // pushContract.test.ts; this is the shape check that belongs with the rest
    // of the project's structural invariants.
    const push = readFileSync(
      join(APP_ROOT, 'src/push/pushFetchSession.ts'),
      'utf8',
    );
    expect(push).toContain('accessGroup');
    expect(push).toContain('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
  });
});

describe('layering', () => {
  it('never calls the network itself', () => {
    // Every request in this app goes through `@momo/core/lib/api`, which owns
    // the 15s deadline, the single-use refresh rotation, the wire decoding and
    // the ApiError/NetworkError split that every Korean failure sentence is
    // written against. A `fetch(` here would be a second, quieter answer to all
    // four — and the first one to go missing would be the deadline, which is
    // the difference between a failure and a spinner that never ends.
    //
    // `refetch(` is react-query asking a query to run AGAIN through that same
    // client, so the lookbehind keeps it (and any `.fetch(` method) out.
    const banned = /(?<![A-Za-z_.])fetch\s*\(/;
    const offenders = sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx')])
      .filter(file => banned.test(codeOf(file)));
    expect(offenders).toEqual([]);
  });

  it('imports the core, never the web client', () => {
    const offenders = sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx'), join(APP_ROOT, 'index.js')])
      .filter(file =>
        /from\s+['"].*clients\/web/.test(readFileSync(file, 'utf8')),
      );
    expect(offenders).toEqual([]);
  });

  it('leaves the core pure — its own gate still passes', () => {
    // The tempting fix for any resolution problem above is to reach into the
    // core and add a React Native import. That would end the extraction. Run the
    // core's own gate from here so this client cannot land a change that breaks
    // it without noticing.
    expect(() =>
      execSync('npm run gate:purity --silent', {
        cwd: join(REPO_ROOT, 'packages/momo-core'),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });
});

describe('what the upload declares stays true of the code (#2568)', () => {
  // App Store Connect reads these Info.plist keys at upload time and never
  // looks at the code again. Each assertion below ties one declaration to the
  // code fact it rests on, so a change that makes the declaration false fails
  // here instead of shipping a false statement to Apple.
  const plist = readFileSync(
    join(APP_ROOT, 'ios/MomoMobile/Info.plist'),
    'utf8',
  );
  const plistString = (key: string) =>
    plist.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
    )?.[1];

  // Everything that ends up in the JS bundle: this client plus the core, which
  // Metro compiles from source (the core's colocated tests do not ship).
  // Comments are stripped (`codeOf`) because the reasoning in them names the very
  // APIs being banned (kv.ts explains why MMKV's `encryptionKey` is not used).
  const shippedCode = () =>
    sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx'), join(APP_ROOT, 'index.js')])
      .concat(
        sourceFiles(join(REPO_ROOT, 'packages/momo-core/src')).filter(
          file => !/\.test\.tsx?$/.test(file),
        ),
      )
      .map(file => ({ file, code: codeOf(file) }));

  const DEVICE_KEY_STORE = join(
    APP_ROOT,
    'modules/momo-device-key-native/ios/MomoDeviceKeyStore.swift',
  );
  const REFRESH_KEY_STORE = join(
    APP_ROOT,
    'modules/momo-device-key-native/ios/MomoRefreshKeyStore.swift',
  );
  /** The only files allowed to import CryptoKit to SIGN: enclave signatures. */
  const SIGNING_KEY_STORES = [DEVICE_KEY_STORE, REFRESH_KEY_STORE];
  /** The only file allowed to import CryptoKit to HASH (#3931): the idempotency
   *  key of a lock-screen decision. */
  const DECISION_KEY = join(
    APP_ROOT,
    'modules/momo-push-action-native/ios/MomoPushActionDecisionKey.swift',
  );
  const HASHING_FILES = [DECISION_KEY];

  function nativeFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        nativeFiles(full, acc);
      } else if (/\.(swift|m|mm|h|c|cc|cpp)$/.test(entry)) {
        acc.push(full);
      }
    }
    return acc;
  }

  it('carries the purpose strings the linked APIs require (ITMS-90683)', () => {
    // Apple checks the binary, not the call sites: expo-image-picker links the
    // photo-library permission API and expo-camera links the microphone one, so
    // an upload without these strings is rejected even though PHPicker never
    // prompts and nothing here records sound. expo-media-library (#4181) also
    // links the photo-library SAVE APIs, so the Add key is required although
    // nothing here saves a photo.
    for (const key of [
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSPhotoLibraryUsageDescription',
      'NSPhotoLibraryAddUsageDescription',
    ]) {
      expect(plistString(key)?.trim()).toBeTruthy();
    }
  });

  it('declares only exempt encryption', () => {
    expect(plist).toMatch(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/,
    );
  });

  it('keeps that declaration true: MMKV is never given a key', () => {
    // MMKVCore is the one linked library that carries its own cipher (AES),
    // and it is off unless someone passes `encryptionKey` or calls
    // `encrypt`/`recrypt`. Everything else is OS-provided: TLS for transport,
    // the keychain for secrets. Turning MMKV encryption on — or reaching for
    // WebCrypto's `subtle` — is encryption outside the OS, and the Info.plist
    // `false` would then be a false export declaration.
    const banned = /\bencryptionKey\b|\.(?:en|re)crypt\s*\(|\bsubtle\b/;
    const offenders = shippedCode()
      .filter(({ code }) => banned.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('keeps that declaration true: no crypto library and no native cipher', () => {
    // A tripwire, not a proof: a dependency whose name says it implements
    // cryptography reopens the question before it can ship unnoticed.
    const pkg = JSON.parse(
      readFileSync(join(APP_ROOT, 'package.json'), 'utf8'),
    );
    expect(
      Object.keys(pkg.dependencies).filter(name =>
        /crypt|sodium|nacl|cipher|ssl|aes\b|argon/i.test(name),
      ),
    ).toEqual([]);
    // The app, the notification extension and the two local Expo modules, in
    // Swift or Objective-C/C: a module import (`import`/`@import`), a header
    // import (`#import`/`#include <CommonCrypto/…>`), a CommonCrypto cipher call
    // (`CCCrypt`, `CCCryptor…`) or a Security-framework key encryption call.
    const nativeCipher =
      /\bimport\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(?:CryptoKit|CommonCrypto)\b|#\s*(?:import|include)\s*<CommonCrypto\b|\bCCCrypt(?:or\w*)?\b|\bSecKeyEncrypt\b|\bSecKeyCreateEncryptedData\b/;
    const native = [
      'ios/MomoMobile',
      'ios/NotificationService',
      'ios/MomoPushKit',
      'modules',
    ]
      .flatMap(dir => nativeFiles(join(APP_ROOT, dir)))
      .filter(file => !SIGNING_KEY_STORES.includes(file))
      .filter(file => !HASHING_FILES.includes(file))
      // The simulator check verifies momo-wire's vector signature with a
      // CryptoKit PUBLIC key (#3106). It is a test program: the podspec links
      // only `ios/`, so it never ships.
      .filter(file => !file.includes('/momo-device-key-native/sim-check/'))
      .filter(file => nativeCipher.test(readFileSync(file, 'utf8')));
    expect(native).toEqual([]);
  });

  // #4316: the notification extension has NO privacy manifest (`ios/NotificationService` holds an Info.plist, an
  // entitlements file and Swift — no `PrivacyInfo.xcprivacy`; only the app declares its required-reason APIs). App Store
  // Connect rejects a build whose binary uses one of those APIs without a declared reason (ITMS-91053), and it reads
  // the extension's binary too. Until the extension gets a manifest of its own it must stay clear of all four
  // categories the app declares: file timestamps, UserDefaults, system boot time, disk space. The face cache keeps
  // "when it was last used" in the file NAME for exactly this reason (MomoPushPresentationStore.swift).
  //
  // The files the extension compiles: its own, the kit, and the one store file it shares with the app's pod.
  // `swiftCode` drops comments and string text, so the reasoning that names these APIs does not trip the guard.
  it('keeps the notification extension clear of required-reason APIs: no file timestamps, no UserDefaults, no boot time, no disk space', () => {
    const EXTENSION_FILES = [
      'ios/NotificationService/NotificationService.swift',
      'ios/MomoPushKit/PushNotification.swift',
      'ios/MomoPushKit/PushCommunication.swift',
      'modules/momo-push-native/ios/MomoPushPresentationStore.swift',
    ].map(file => join(APP_ROOT, file));
    const REQUIRED_REASON_APIS: [string, RegExp][] = [
      [
        'file timestamps',
        /\b(?:modificationDate|creationDate|fileModificationDate|fileCreationDate|NSFileModificationDate|NSFileCreationDate|contentModificationDate|contentModificationDateKey|creationDateKey|attributesOfItem|setAttributes|getattrlist\w*|fgetattrlist|getattrlistat)\b|\b(?:stat|fstat|fstatat|lstat)\s*\(/,
      ],
      ['UserDefaults', /\b(?:UserDefaults|NSUserDefaults)\b/],
      ['system boot time', /\b(?:systemUptime|mach_absolute_time|clock_gettime_nsec_np)\b/],
      [
        'disk space',
        /\b(?:volumeAvailableCapacity\w*|volumeTotalCapacity|systemFreeSize|systemSize|NSFileSystemFreeSize|NSFileSystemSize|statfs|fstatfs|statvfs)\b/,
      ],
    ];
    const offenders = EXTENSION_FILES.flatMap(file => {
      const code = swiftCode(readFileSync(file, 'utf8'));
      return REQUIRED_REASON_APIS.filter(([, pattern]) => pattern.test(code)).map(
        ([category]) => `${file.replace(APP_ROOT + '/', '')}: ${category}`,
      );
    });
    expect(offenders).toEqual([]);
    // The guard is not vacuous: the files were read, and the app's own manifest still declares what the pod needs.
    expect(EXTENSION_FILES.every(file => readFileSync(file, 'utf8').length > 1000)).toBe(true);
    expect(existsSync(join(APP_ROOT, 'ios/NotificationService/PrivacyInfo.xcprivacy'))).toBe(false);
  });

  // #3931: the third sanctioned CryptoKit import, and the only one that does not
  // sign. A lock-screen 승인/거절 is answered without a screen, and the server's
  // idempotency key for it (`client_decision_id`) must be one nobody else can
  // compute from the notification's public ids — so it is a SHA-256 over a secret
  // that never leaves the phone's app-only keychain group. That is hashing, which
  // is not encryption, and it is the same reading the signing keys above rest on
  // (authentication, not confidentiality). What would make the reading false is a
  // cipher or a keyed primitive creeping into this file, and this test is what
  // notices.
  //
  // It is an ALLOWLIST, not a list of banned names (the independent security review of
  // #3931 got past the first version with `import CommonCrypto` + `CCHmac`, and `HKDF`
  // was never on it): the file may import exactly Foundation and CryptoKit, and the only
  // thing it may take from CryptoKit is `SHA256.hash(`. Any other name that belongs to a
  // crypto API — a CryptoKit type, a CommonCrypto `CC…` call, a Security `Sec…`/`kSec…`
  // symbol — fails it, wherever it appears in code (comments and string text do not
  // count; an interpolated expression does). A cipher whose name is on neither list still
  // has to be spotted by a person, which is why the name list is broad.
  const CRYPTO_NAMES =
    /\b(?:CC[A-Z]\w*|Sec[A-Z]\w*|kSec\w*|AES\w*|ChaCha\w*|HMAC|HKDF|PBKDF\w*|Curve25519|X25519|Ed25519|P256|P384|P521|SymmetricKey|SealedBox|HPKE|KEM\w*|XWing\w*|MLKEM\w*|MLDSA\w*|Insecure|SecureEnclave|SharedSecret|KeyAgreement|MD5|Nonce|Kyber\w*|Dilithium\w*|SLH\w*)\b|\bSHA(?!256\b)\w*/;
  // Ways to reach a C crypto symbol by NAME, which the identifier list cannot see (the name is a string).
  const SYMBOL_BACKDOORS = /@_silgen_name|@_cdecl|@_extern|\bdlsym\b|\bdlopen\b|\bCFBundleGetFunctionPointer\w*/;
  const importsOf = (code: string): string[] =>
    [
      ...code.matchAll(
        /(?<![\w.])(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|internal|package|private|fileprivate)\s+)?import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([\w.]+)/g,
      ),
    ]
      .map(match => match[1])
      .sort();
  const shaUses = (code: string): string[] =>
    [...code.matchAll(/\bSHA256\b[^\n]{0,12}/g)].map(match => match[0]);
  /** True when the code breaks the allowlist: another import, a SHA256 use that is not `.hash(`, or a crypto name. */
  const breaksAllowlist = (code: string): boolean =>
    JSON.stringify(importsOf(code)) !== JSON.stringify(['CryptoKit', 'Foundation']) ||
    !shaUses(code).every(use => /^SHA256\.hash\(/.test(use)) ||
    CRYPTO_NAMES.test(code) ||
    SYMBOL_BACKDOORS.test(code);

  it('keeps that declaration true: the decision key only HASHES (#3931)', () => {
    const code = swiftCode(readFileSync(DECISION_KEY, 'utf8'));

    expect(importsOf(code)).toEqual(['CryptoKit', 'Foundation']);
    // The one thing taken from CryptoKit, and it is used.
    expect(shaUses(code).length).toBeGreaterThan(0);
    expect(shaUses(code).every(use => /^SHA256\.hash\(/.test(use))).toBe(true);
    expect(code.match(CRYPTO_NAMES)?.[0]).toBeUndefined();
    expect(code.match(SYMBOL_BACKDOORS)?.[0]).toBeUndefined();
    expect(breaksAllowlist(code)).toBe(false);

    // No other file in the module may import a crypto module at all.
    const moduleFiles = nativeFiles(join(APP_ROOT, 'modules/momo-push-action-native'));
    expect(
      moduleFiles.filter(file =>
        /(?<![\w.])import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?(?:CryptoKit|CommonCrypto)\b/.test(
          swiftCode(readFileSync(file, 'utf8')),
        ),
      ),
    ).toEqual([DECISION_KEY]);
  });

  // Mutation probes for the guard itself: each of these, appended to the real file, must be
  // seen. A guard that cannot fail proves nothing (the same reason `swiftCode` has its own
  // tests above).
  it.each([
    ['CommonCrypto HMAC', 'import CommonCrypto\nfunc probe() { var mac = [UInt8](repeating: 0, count: 32); CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), "k", 1, "d", 1, &mac) }'],
    ['CommonCrypto without a cipher call, only the import', 'import CommonCrypto'],
    ['HKDF key derivation', 'func probe(s: Data) { _ = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: s), outputByteCount: 32) }'],
    ['AES-GCM', 'func probe(d: Data, k: SymmetricKey) { _ = try? AES.GCM.seal(d, using: k) }'],
    ['ChaCha', 'func probe(d: Data, k: SymmetricKey) { _ = try? ChaChaPoly.seal(d, using: k) }'],
    ['HMAC', 'func probe(d: Data, k: SymmetricKey) { _ = HMAC<SHA256>.authenticationCode(for: d, using: k) }'],
    ['a Security key', 'import Security\nfunc probe() { _ = SecKeyCreateRandomKey([:] as CFDictionary, nil) }'],
    ['a cipher inside a string interpolation', 'let probe = "\\(AES.GCM.Nonce())"'],
    ['SHA-512', 'func probe(d: Data) { _ = SHA512.hash(data: d) }'],
    ['an incremental SHA-256 hasher', 'func probe() { var hasher = SHA256(); hasher.update(data: Data()) }'],
    ['a submodule import', '@_exported import CryptoKit.Foo'],
    ['an import after a semicolon on the same line', 'let x = 1; import CommonCrypto'],
    ['an import after a regex literal', 'let r = #/a//b/#; import CommonCrypto'],
    ['SHA3', 'func probe(d: Data) { _ = SHA3_256.hash(data: d) }'],
    ['SLH-DSA', 'func probe() { _ = SLHDSA.self }'],
    ['a C crypto symbol reached by name', '@_silgen_name("CCHmac") func probe()'],
    ['dlsym', 'let probe = dlsym(nil, "CCHmac")'],
    ['a symbol looked up through a bundle', 'let probe = CFBundleGetFunctionPointerForName(nil, "CCHmac" as CFString)'],
    ['an import with a newline after the keyword', 'import\nCommonCrypto'],
    ['an import with a form feed after the keyword', 'import\fCommonCrypto'],
  ])('the guard sees %s appended to the file', (_name, appended) => {
    const real = readFileSync(DECISION_KEY, 'utf8');
    expect(breaksAllowlist(swiftCode(`${real}\n${appended}\n`))).toBe(true);
  });

  it('and ignores the same words in a comment or in string text (the guard does not cry wolf)', () => {
    const real = readFileSync(DECISION_KEY, 'utf8');
    const harmless = '// import CommonCrypto; CCHmac(HKDF<SHA256>) AES.GCM\nlet note = "AES.GCM and HMAC and import Security"\n/* SecKeyCreateRandomKey */';
    expect(breaksAllowlist(swiftCode(`${real}\n${harmless}\n`))).toBe(false);
  });

  // #3106: the refresh key is the second sanctioned CryptoKit import — a
  // Secure Enclave ECDSA signature over a proof, and SHA-256 of the refresh
  // token inside it. Authentication, not confidentiality: the same rule.
  it.each([
    ['the device key (#3026)', DEVICE_KEY_STORE],
    ['the refresh key (#3106)', REFRESH_KEY_STORE],
  ])('keeps that declaration true: %s only SIGNS', (_name, file) => {
    const code = readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toMatch(/\bimport\s+CryptoKit\b/);
    expect(code).not.toMatch(
      /\b(?:AES|ChaChaPoly|SealedBox|HPKE|SymmetricKey|KeyAgreement|sharedSecretFromKeyAgreement|HMAC|SecKeyEncrypt|SecKeyCreateEncryptedData|SecKeyCopyKeyExchangeResult)\b/,
    );
    const enclaveUses = code.match(/SecureEnclave\.P256\.\w+/g) ?? [];
    expect(enclaveUses.length).toBeGreaterThan(0);
    expect(new Set(enclaveUses)).toEqual(new Set(['SecureEnclave.P256.Signing']));
  });

  it('keeps the microphone sentence true: nothing asks for the microphone', () => {
    // The purpose string tells the person oort does not record. The first
    // feature that asks for the microphone makes that sentence false, so it has
    // to change in the same PR. String literals are kept here on purpose:
    // `mode="video"` is how CameraView starts recording sound.
    const banned =
      /\b(?:requestMicrophonePermissionsAsync|getMicrophonePermissionsAsync|useMicrophonePermissions|recordAsync|requestRecordingPermissionsAsync|useAudioRecorder)\b|\bmode\s*=\s*\{?\s*['"]video['"]/;
    const offenders = shippedCode()
      .filter(({ code }) => banned.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    const pkg = JSON.parse(
      readFileSync(join(APP_ROOT, 'package.json'), 'utf8'),
    );
    expect(
      Object.keys(pkg.dependencies).filter(name =>
        /audio|voice|webrtc|record|speech|^expo-av$/i.test(name),
      ),
    ).toEqual([]);
  });
});

describe('what the photo library declaration says stays true of the code (#4181, ADR-0168 증보 1)', () => {
  const plist = readFileSync(
    join(APP_ROOT, 'ios/MomoMobile/Info.plist'),
    'utf8',
  );
  const plistString = (key: string) =>
    plist.match(
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`),
    )?.[1];
  const shipped = () =>
    sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx'), join(APP_ROOT, 'index.js')])
      .map(file => ({ file, code: codeOf(file) }));
  const PHOTOS_NATIVE = join(
    APP_ROOT,
    'src/features/attachments/photosNative.ts',
  );

  it('keeps the Add sentence true: nothing writes to the photo library', () => {
    // The Add purpose string tells the person oort does not save photos. Those
    // are the expo-media-library write/album/delete functions plus the two
    // PhotoKit save entry points a native bridge would call.
    const banned =
      /\b(?:saveToLibraryAsync|createAssetAsync|addAssetsToAlbumAsync|removeAssetsFromAlbumAsync|deleteAssetsAsync|createAlbumAsync|deleteAlbumsAsync|setAssetFavoriteAsync|UIImageWriteToSavedPhotosAlbum|PHAssetChangeRequest|PHAssetCreationRequest)\b/;
    const offenders = shipped()
      .filter(({ code }) => banned.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
    expect(plistString('NSPhotoLibraryAddUsageDescription')).toMatch(
      /저장하지 않아요/,
    );
  });

  it('reads the photo library through exactly one file, and only the legacy entry', () => {
    // SDK 57's package root throws for the old function names (see the header of
    // photosNative.ts), and a second importer would put native calls behind a
    // seam the card tests cannot swap.
    const importers = shipped()
      .filter(({ code }) => /['"]expo-media-library(?:\/[a-z]+)?['"]/.test(code))
      .map(({ file }) => file);
    expect(importers).toEqual([PHOTOS_NATIVE]);
    const code = codeOf(PHOTOS_NATIVE);
    expect(code).toMatch(/from ['"]expo-media-library\/legacy['"]/);
    expect(code).not.toMatch(/from ['"]expo-media-library['"]/);
  });

  it('registers the ph:// image loader — expo modules are not in codegen\'s autolinked list', () => {
    // Without this the photo card's thumbnails die with the RedBox "No suitable image URL loader
    // found for ph://…" under Bridgeless (seen on the simulator, #4181): codegen reads
    // `modulesConformingToProtocol` only for libraries the community CLI autolinks, and
    // expo-media-library is autolinked by Expo, so the generated `imageURLLoaderClassNames` is empty.
    const delegate = readFileSync(
      join(APP_ROOT, 'ios/MomoMobile/AppDelegate.swift'),
      'utf8',
    );
    expect(delegate).toMatch(/imageURLLoaderClassNames\(\)[^{]*\{[\s\S]*?"MediaLibraryImageLoader"/);
    expect(delegate).toMatch(/dependencyProvider\s*=\s*MomoDependencyProvider\(\)/);
    // And the class really is the one the pod ships.
    const loader = readFileSync(
      join(APP_ROOT, 'node_modules/expo-media-library/ios/MediaLibraryImageLoader.m'),
      'utf8',
    );
    expect(loader).toMatch(/@implementation MediaLibraryImageLoader/);
  });

  it('asks in the person\'s language: the read sentence is 해요체 and names the purpose', () => {
    const read = plistString('NSPhotoLibraryUsageDescription') ?? '';
    expect(read).toMatch(/최근 사진/);
    expect(read).toMatch(/요\.?$/);
    expect(read).not.toMatch(/(?:습니다|ㅂ니다)\.?$/);
  });

  it('never requests photo access before a person taps 「허용」', () => {
    // The permission calls live in photosNative.ts and are reached only from the
    // card hook's `request` (미결정 + 「허용」) and `getPermission` (a read). Nothing
    // else in the shipped code may call them — a call from app start, the
    // composer or the menu would be the preflight the ADR forbids.
    const callers = shipped()
      .filter(
        ({ file, code }) =>
          file !== PHOTOS_NATIVE &&
          /\b(?:requestPermissionsAsync|getPermissionsAsync)\b/.test(code) &&
          // expo-notifications and expo-camera have their own, unrelated, permission calls.
          /expo-media-library/.test(code),
      )
      .map(({ file }) => file);
    expect(callers).toEqual([]);
    const hook = codeOf(
      join(APP_ROOT, 'src/features/attachments/usePhotoLibrary.ts'),
    );
    // `requestPermission` is reached from exactly one place: the 미결정-only `request` action.
    expect(hook.match(/requestPermission\(/g)?.length).toBe(1);
    expect(hook).toMatch(/permissionRef\.current !== ['"]undetermined['"]/);
  });
});

describe('the app icon App Store Connect requires (#2643)', () => {
  // The first TestFlight upload (build 3023) was rejected with 90713 (no
  // CFBundleIconName), 90022 (iPhone 120) and 90023 (iPad 152/167). The RN
  // template's AppIcon set held a Contents.json and no image, and every local
  // build and gate stayed green. actool derives those Info.plist keys and every
  // device size from one 1024 image (the single-size catalog), so the guard is
  // on that one file.
  const ICONSET = join(
    APP_ROOT,
    'ios/MomoMobile/Images.xcassets/AppIcon.appiconset',
  );
  const images = () =>
    JSON.parse(readFileSync(join(ICONSET, 'Contents.json'), 'utf8'))
      .images as Array<Record<string, string>>;

  it('is one universal 1024 image, present as a real file', () => {
    const list = images();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      idiom: 'universal',
      platform: 'ios',
      size: '1024x1024',
    });
    expect(list[0].filename).toBeTruthy();
    expect(existsSync(join(ICONSET, list[0].filename))).toBe(true);
  });

  it('is a 1024x1024 PNG without an alpha channel', () => {
    // App Store Connect rejects an icon with alpha. The PNG header says it
    // directly: IHDR colour type 2 is RGB; 6 is RGBA and 4 is grey + alpha, and
    // a tRNS chunk would make even an RGB image transparent.
    const png = readFileSync(join(ICONSET, images()[0].filename));
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.toString('latin1', 12, 16)).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    expect(png[25]).toBe(2);
    const chunks: string[] = [];
    for (let at = 8; at + 8 <= png.length; at += 12 + png.readUInt32BE(at)) {
      chunks.push(png.toString('latin1', at + 4, at + 8));
    }
    expect(chunks).not.toContain('tRNS');
    expect(chunks[chunks.length - 1]).toBe('IEND');
  });

  it('is the set the app target compiles', () => {
    // Both configurations of the app target; the extension has no icon.
    expect(
      readFileSync(PBXPROJ, 'utf8').match(
        /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;/g,
      )?.length,
    ).toBe(2);
  });
});

describe('the launch screen is the boot background and nothing else (#2668)', () => {
  // TestFlight build 3023.1 opened on the RN template's launch screen:
  // 「MomoMobile」 and 「Powered by React Native」 on system white, unchanged since
  // the scaffold (faebfcaf). Apple's HIG asks for a launch screen that is the
  // first screen with its content taken out — no words, no logo — so the only
  // thing this one may carry is the background the boot screen paints next.
  //
  // Three surfaces paint that background before any content exists, in order:
  // the launch storyboard, the React root view (React Native paints it
  // `systemBackgroundColor`, pure white or black, until JS draws its first frame
  // — RCTRootViewFactory.mm), and the boot screen (`Booting` in App.tsx, token
  // `bg`). One named colour feeds the first two and has to equal the token that
  // feeds the third, or opening the app blinks. Every assertion below is on a
  // file, because a blink is invisible to every test that renders React.
  //
  // #4526 (ADR-0189 amendment 5, owner 2026-10-26) changed what "equal" means.
  // The colour used to have a light and a dark variant, each equal to the
  // palette `bg` of the same name, on the premise that the variant iOS picks (the
  // device's appearance) is the scheme the app boots in. That held only while
  // the phone's default was "follow the system". Once the default became light, a
  // dark device that never chose opened on a dark launch screen and then flipped
  // to the light app — and this suite stayed green, because it only compared
  // each variant with its palette and never looked at the premise. The decision
  // is that the launch screen is LIGHT whatever the device says, so the asset is
  // now ONE colour with no appearance variant, equal to the light `bg` (what a
  // phone that never chose boots in), and the premise is asserted below. The
  // mirror cost is accepted: a phone that chose dark (or follows a dark system)
  // sees one light surface before its first dark frame.
  const IOS_APP = join(APP_ROOT, 'ios/MomoMobile');
  const COLOR_NAME = 'LaunchBackground';
  const plist = readFileSync(join(IOS_APP, 'Info.plist'), 'utf8');
  const storyboardName = plist.match(
    /<key>UILaunchStoryboardName<\/key>\s*<string>([^<]*)<\/string>/,
  )?.[1];
  const storyboard = () =>
    readFileSync(join(IOS_APP, `${storyboardName}.storyboard`), 'utf8');

  // An asset catalog colour component is written in one of three encodings,
  // depending on which input method Xcode's inspector last saved it with.
  const componentByte = (value: string): number =>
    /^0x[0-9a-f]{2}$/i.test(value)
      ? parseInt(value.slice(2), 16)
      : value.includes('.')
      ? Math.round(parseFloat(value) * 255)
      : parseInt(value, 10);
  const hex = (components: Record<string, string>): string =>
    '#' +
    ['red', 'green', 'blue']
      .map(channel =>
        componentByte(components[channel]).toString(16).padStart(2, '0'),
      )
      .join('');

  it('is the storyboard Info.plist launches', () => {
    // Otherwise every check below could pass on a file iOS never shows.
    expect(storyboardName).toBe('LaunchScreen');
    expect(storyboard()).toContain('launchScreen="YES"');
  });

  it('carries no words and no mark', () => {
    const xml = storyboard();
    expect(xml).not.toContain('Powered by React Native');
    expect(xml).not.toContain('MomoMobile');
    expect(xml.match(/<label\b/g) ?? []).toHaveLength(0);
    expect(xml.match(/<imageView\b/g) ?? []).toHaveLength(0);
    // Not only labels: a button title or a text view is text too. Background
    // only means the view has nothing inside it.
    expect(xml).not.toContain('<subviews>');
    expect(xml).not.toMatch(/\btext="/);
  });

  it('paints one named colour, not a system one', () => {
    const backgrounds = [
      ...storyboard().matchAll(/<color key="backgroundColor"([^>]*)\/>/g),
    ].map(m => m[1]);
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0]).toContain(`name="${COLOR_NAME}"`);
    expect(backgrounds[0]).not.toContain('systemColor=');
  });

  it('stands on the phone booting light when nothing was chosen', () => {
    // The asset below is pinned light BECAUSE the phone's default is light. If
    // the default moves, this colour has to move with it, and so does the
    // decision recorded in ADR-0189 amendment 5. Without this line the next
    // change of default would leave the suite green over a launch screen that
    // contradicts it — the state #4526 started from.
    expect(DEFAULT_THEME_CHOICE).toBe('light');
  });

  it('is one light colour with no variant for the device appearance, byte for byte', () => {
    const colors = JSON.parse(
      readFileSync(
        join(IOS_APP, `Images.xcassets/${COLOR_NAME}.colorset/Contents.json`),
        'utf8',
      ),
    ).colors as Array<{
      idiom: string;
      appearances?: Array<{ appearance: string; value: string }>;
      color: { 'color-space': string; components: Record<string, string> };
    }>;
    // ONE entry, and no `appearances` key on it. iOS picks a dark (or high
    // contrast) variant on a device in that mode: that is the dark launch screen
    // over a light app this asset used to cause. The count alone would not say
    // so, because a lone dark variant is also one entry; the second check does.
    expect(colors).toHaveLength(1);
    expect(colors.every(entry => entry.appearances === undefined)).toBe(true);
    const only = colors[0];
    // sRGB, because that is how React Native reads a hex string
    // (RCTDefaultReactNativeFactoryDelegate.defaultColorSpace). The same bytes
    // in Display P3 would be a different colour on this phone's screen.
    expect(only.idiom).toBe('universal');
    expect(only.color['color-space']).toBe('srgb');
    expect(componentByte(only.color.components.alpha)).toBe(255);
    expect(hex(only.color.components)).toBe(lightPalette.bg);
  });

  it('is not undone by pinning the whole app to one interface style', () => {
    // The tempting way to "always light" is UIUserInterfaceStyle = Light in
    // Info.plist, overrideUserInterfaceStyle (or traitOverrides) on the window,
    // or Appearance.setColorScheme('light') from JS. Each gives a light launch
    // screen, and each also freezes React Native's `Appearance` at light for the
    // whole app: the 「시스템」 choice stops following the device and 「지금 이
    // 기기의 시스템은 …」 becomes false. The asset is the whole fix; these four
    // shapes must stay absent. (Anything else that pins the style is not seen
    // here — the guard names what it holds.)
    //
    // An XML comment is not a key: a note in Info.plist may name the key it forbids.
    const plistKeys = plist.replace(/<!--[\s\S]*?-->/g, '');
    expect(plistKeys).not.toContain('UIUserInterfaceStyle');
    const swift = readFileSync(join(IOS_APP, 'AppDelegate.swift'), 'utf8');
    // A statement, not a comment: `[^/\n]*` cannot reach past a `//`.
    expect(swift).not.toMatch(/^[^/\n]*(overrideUserInterfaceStyle|traitOverrides)/m);
    const callers = [
      join(APP_ROOT, 'App.tsx'),
      join(APP_ROOT, 'index.js'),
      ...sourceFiles(join(APP_ROOT, 'src')),
    ]
      .filter(file => existsSync(file))
      .filter(file =>
        /\bsetColorScheme\s*\(/.test(stripComments(file, readFileSync(file, 'utf8'))),
      )
      .map(file => file.slice(APP_ROOT.length + 1));
    expect(callers).toEqual([]);
  });

  it('is what the React root view paints until the first frame', () => {
    // A statement at the start of a line, so a comment naming it does not count.
    const swift = readFileSync(join(IOS_APP, 'AppDelegate.swift'), 'utf8');
    expect(swift).toMatch(
      new RegExp(
        `^\\s*rootView\\.backgroundColor\\s*=\\s*UIColor\\(named:\\s*"${COLOR_NAME}"\\)`,
        'm',
      ),
    );
  });
});

describe('the local upload build number rule (#2568)', () => {
  // Xcode Cloud numbers its builds in the 2000s (2035, 2039). Local uploads
  // take 3000 + the KST day count since 2026-09-01, so the two never collide
  // and no counter file has to be committed. App Store Connect only accepts a
  // number higher than the previous upload of the same version.
  const script = join(APP_ROOT, 'scripts/archive-release.sh');
  const kst = (local: string) =>
    Math.floor(Date.parse(`${local}+09:00`) / 1000);
  const buildNumber = (now: number, ...args: string[]) =>
    execFileSync('bash', [script, '--print-build-number', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MOMO_IOS_BUILD_NOW: String(now),
        MOMO_IOS_BUILD_NUMBER: '',
      },
      stdio: 'pipe',
    }).trim();

  it('is 3000 plus the KST day count since 2026-09-01', () => {
    expect(buildNumber(kst('2026-09-01T00:00:00'))).toBe('3000');
    expect(buildNumber(kst('2026-09-23T23:59:59'))).toBe('3022');
    // The day turns at midnight in Seoul, not in UTC.
    expect(buildNumber(kst('2026-09-24T00:00:00'))).toBe('3023');
    expect(buildNumber(kst('2027-09-01T00:00:00'))).toBe('3365');
  });

  it('numbers a same-day re-upload above the first one', () => {
    expect(buildNumber(kst('2026-09-23T12:00:00'), '--seq', '1')).toBe(
      '3022.1',
    );
  });

  it('refuses a clock from before the rule', () => {
    expect(() => buildNumber(kst('2026-08-31T23:59:59'))).toThrow();
  });

  it('is committed executable', () => {
    const entry = execSync(
      'git ls-files -s -- clients/mobile/scripts/archive-release.sh',
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();
    expect(entry.split(' ')[0]).toBe('100755');
  });
});
