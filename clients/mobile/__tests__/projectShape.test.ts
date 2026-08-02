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

  it('is signed by the team that owns those capabilities', () => {
    expect(pbxproj).toContain('DEVELOPMENT_TEAM = YWQQFQM38J;');
    expect(pbxproj.match(/DEVELOPMENT_TEAM = YWQQFQM38J;/g)?.length).toBe(2);
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
          .replace(/^\s*\/\/.*$/gm, '');
        return banned.test(source);
      });
    expect(offenders).toEqual([]);
  });
});

describe('the NSE seam stays aligned with the Swift side', () => {
  it('names the access group PushNotification.swift reads', () => {
    // Not applied yet — applying it needs the matching entitlement, and without
    // one `SecItemAdd` fails only on a device. Pinned so the NSE batch (이행
    // 순서 5) finds one constant to change and this test to update.
    expect(NSE_KEYCHAIN_ACCESS_GROUP).toBe('app.momo.ios.shared');
  });
});

describe('layering', () => {
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
