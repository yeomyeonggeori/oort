import {execSync} from 'child_process';
import {existsSync, readFileSync, readdirSync, statSync} from 'fs';
import {join, resolve} from 'path';
import {NSE_KEYCHAIN_ACCESS_GROUP} from '../src/storage/secureSession';

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
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
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
      tracked('clients/mobile/ios/MomoMobile.xcworkspace/contents.xcworkspacedata'),
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
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
    expect(pkg.engines.node).toBe(`>= ${pin}`);
  });
});

describe('Android is on hold, not half-started (성재 결정 6)', () => {
  it('has no android directory', () => {
    expect(existsSync(join(APP_ROOT, 'android'))).toBe(false);
  });

  it('has no android build script', () => {
    const pkg = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
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
    const plist = readFileSync(join(APP_ROOT, 'ios/MomoMobile/Info.plist'), 'utf8');
    expect(plist).toContain('<string>oort</string>');
    expect(plist).toContain('<string>momo</string>');
  });

  it('keeps ATS open for local networking only', () => {
    const plist = readFileSync(join(APP_ROOT, 'ios/MomoMobile/Info.plist'), 'utf8');
    expect(plist).toMatch(/NSAllowsLocalNetworking<\/key>\s*<true\/>/);
    // The switch that requires justification at review stays off.
    expect(plist).toMatch(/NSAllowsArbitraryLoads<\/key>\s*<false\/>/);
  });
});

describe('boot order (spike #837 gate 2)', () => {
  const entry = readFileSync(join(APP_ROOT, 'index.js'), 'utf8');
  const imports = [...entry.matchAll(/^import\s+(?:.*\s+from\s+)?['"](.+)['"];/gm)].map(
    m => m[1],
  );

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
    const banned = /\b(document|localStorage|sessionStorage)\b|\bwindow\.|\bnavigator\.|\blocation\.href\b/;
    const offenders = sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx'), join(APP_ROOT, 'index.js')])
      .filter(file => {
        const source = readFileSync(file, 'utf8')
          // Comments discuss these globals by name constantly; a text search
          // that did not strip them would drown, then get tuned until it caught
          // nothing. Same reasoning the core's purity gate gives for parsing.
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
          // Module specifiers and UI copy are values, not global reads. Without
          // stripping strings, `expo-document-picker` is mistaken for the DOM
          // `document` global even though the source never evaluates it.
          .replace(/(['"])(?:\\.|(?!\1).)*\1/g, '');
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
      .filter(file => {
        const source = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '');
        return banned.test(source);
      });
    expect(offenders).toEqual([]);
  });

  it('imports the core, never the web client', () => {
    const offenders = sourceFiles(join(APP_ROOT, 'src'))
      .concat([join(APP_ROOT, 'App.tsx'), join(APP_ROOT, 'index.js')])
      .filter(file => /from\s+['"].*clients\/web/.test(readFileSync(file, 'utf8')));
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
