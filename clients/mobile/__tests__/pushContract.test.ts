import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  PUSH_ACTION,
  PUSH_CATEGORY,
  PUSH_ENVELOPE_SCHEMA,
  PUSH_FETCH_SESSION_ACCOUNT,
  PUSH_KEYCHAIN_SERVICE,
  PUSH_REASONS,
  PUSH_TOPIC,
} from '../src/push/contract';

// =============================================================================
// The app and the notification extension are two binaries with no shared types.
// They agree by string, or they do not agree at all — and when they do not, the
// extension fails OPEN: the notification still arrives, carrying the relay's
// placeholder instead of the message. Nothing throws, nothing logs, and the
// symptom ("pushes arrive but say 새 알림") looks like a server problem.
//
// So this suite reads the Swift source and compares. It is the only mechanism
// that can catch the drift, because no build step spans both sides.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const IOS = join(APP_ROOT, 'ios');
const SWIFT = readFileSync(join(IOS, 'MomoPushKit/PushNotification.swift'), 'utf8');

/** Pull `public static let <name> = "<value>"` out of the Swift source. */
function swiftConstant(name: string): string {
  const match = SWIFT.match(
    new RegExp(`static let ${name}\\s*=\\s*"([^"]+)"`),
  );
  if (!match) throw new Error(`no Swift constant named ${name}`);
  return match[1];
}

/** Pull `case <name> = "<value>"` out of a Swift enum. */
function swiftCase(name: string): string {
  const match = SWIFT.match(new RegExp(`case ${name}\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`no Swift case named ${name}`);
  return match[1];
}

describe('the JS push contract matches the Swift the extension runs', () => {
  it('addresses the same keychain item', () => {
    // These two are the handoff itself. A mismatch here is the single failure
    // the 2026-08-02 audit called the hardest to detect (§2.3).
    expect(PUSH_KEYCHAIN_SERVICE).toBe(swiftConstant('secureSessionService'));
    expect(PUSH_FETCH_SESSION_ACCOUNT).toBe(
      swiftConstant('pushFetchSessionAccount'),
    );
  });

  it('uses the same category identifiers', () => {
    expect(PUSH_CATEGORY.message).toBe(swiftCase('message'));
    expect(PUSH_CATEGORY.mention).toBe(swiftCase('mention'));
    expect(PUSH_CATEGORY.approval).toBe(swiftCase('approval'));
    // ADR-0204 D7 (#3928): the approval the lock screen must not decide.
    expect(PUSH_CATEGORY.approvalOpen).toBe(swiftCase('approvalOpen'));
    expect(PUSH_CATEGORY.work).toBe(swiftCase('work'));
  });

  it('has exactly the same set of categories — a name in one place only is drift', () => {
    // Pairwise equality above cannot see a category that exists on one side only
    // (the relay would send it, the other side would not decode it, and the
    // notification would silently lose its buttons).
    const block = SWIFT.match(/enum MomoPushCategory[^{]*\{([\s\S]*?)\n\}/);
    if (!block) throw new Error('no MomoPushCategory enum in the Swift source');
    const swiftValues = [...block[1].matchAll(/case\s+\w+\s*=\s*"([^"]+)"/g)].map(
      m => m[1],
    );
    expect([...swiftValues].sort()).toEqual(Object.values(PUSH_CATEGORY).sort());
  });

  it('names the same categories as the relay and the server that sends them (ADR-0204 D7: four places)', () => {
    // The category set lives in four places: the relay that validates it, the server
    // that chooses it (`momo-push`), the phone, and the extension. JS↔Swift is
    // compared above; this closes the other two sides. A category the server sends
    // that the relay does not know is a 400 the relay settles for good; one the relay
    // accepts that the phone does not register is a notification without buttons —
    // and neither throws anywhere.
    const read = (path: string) => readFileSync(join(APP_ROOT, '../..', path), 'utf8');
    const relay = read('server-rust/bins/momo-push-relay/src/dispatch.rs');
    const sender = read('server-rust/crates/momo-push/src/dispatch.rs');
    const wanted = Object.values(PUSH_CATEGORY).sort();

    const allowed = relay.match(/const ALLOWED_CATEGORIES: &\[&str\] = &\[([\s\S]*?)\];/);
    if (!allowed) throw new Error('no ALLOWED_CATEGORIES in the relay source');
    // Every quoted string in the block, not only the ones shaped like today's names:
    // a category spelled with an underscore or a digit must not slip past the match.
    expect([...allowed[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).sort()).toEqual(wanted);

    const sounds = relay.match(/const CATEGORY_SOUNDS: [^=]*= &\[([\s\S]*?)\];/);
    if (!sounds) throw new Error('no CATEGORY_SOUNDS in the relay source');
    expect(
      [...sounds[1].matchAll(/\("([^"]+)",/g)].map(m => m[1]).sort(),
    ).toEqual(wanted);

    expect(
      [...sender.matchAll(/PushCategory::\w+ => "([^"]+)"/g)].map(m => m[1]).sort(),
    ).toEqual(wanted);
  });

  it('uses the same action identifiers', () => {
    // The identifiers RNFirebase could not deliver to JS, which is why
    // expo-notifications was chosen (ADR-0137 D7 정오 5항).
    expect(PUSH_ACTION.quickReply).toBe(swiftConstant('quickReply'));
    expect(PUSH_ACTION.approve).toBe(swiftConstant('approve'));
    expect(PUSH_ACTION.reject).toBe(swiftConstant('reject'));
    // The single button of `momo.approval.open` (ADR-0204 D7).
    expect(PUSH_ACTION.openApproval).toBe(swiftConstant('openApproval'));
  });

  it('has exactly the same set of action identifiers', () => {
    const block = SWIFT.match(/enum MomoPushActionIdentifier \{([\s\S]*?)\n\}/);
    if (!block) throw new Error('no MomoPushActionIdentifier enum in the Swift source');
    const swiftValues = [
      ...block[1].matchAll(/static let \w+\s*=\s*"([^"]+)"/g),
    ].map(m => m[1]);
    expect([...swiftValues].sort()).toEqual(Object.values(PUSH_ACTION).sort());
  });

  it('names the same categories as carrying an approval id (ADR-0204 D7)', () => {
    // Both approval categories name their approval; no other category may. The
    // Swift parser and `parsePushEnvelope` each enforce that as one biconditional,
    // and this pins the SET it ranges over to the same two on both sides.
    const predicate = SWIFT.match(/var carriesApprovalID: Bool \{([^}]*)\}/);
    if (!predicate) throw new Error('no carriesApprovalID in the Swift source');
    const swiftApprovalCategories = [...predicate[1].matchAll(/\.(\w+)/g)]
      .map(m => swiftCase(m[1]))
      .sort();
    expect(swiftApprovalCategories).toEqual(
      [PUSH_CATEGORY.approval, PUSH_CATEGORY.approvalOpen].sort(),
    );
    // And the Swift parser gates the id on that predicate, in both directions.
    expect(SWIFT).toContain(
      'root.aps.category.carriesApprovalID == (approvalID.flatMap(UUID.init(uuidString:)) != nil)',
    );
    expect(SWIFT).toContain(
      '(root.aps.category.carriesApprovalID || approvalID == nil)',
    );
  });

  it('gates on the same payload schema and reasons', () => {
    expect(SWIFT).toContain(`payload.schema == "${PUSH_ENVELOPE_SCHEMA}"`);
    for (const reason of PUSH_REASONS) {
      expect(SWIFT).toContain(`"${reason}"`);
    }
    // Containment is not equality: a sixth reason in Swift only (or a stale one
    // left behind) would pass the loop above. Compare the whole list.
    const gate = SWIFT.match(/\[((?:"[a-z_]+",?\s*)+)\]\.contains\(payload\.reason\)/);
    if (!gate) throw new Error('no reason gate in the Swift source');
    const swiftReasons = [...gate[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
    expect(swiftReasons).toEqual([...PUSH_REASONS]);
    expect(PUSH_REASONS).toContain('work_session_idle');
    expect(PUSH_REASONS).toContain('work_run_done');
    // ADR-0206 증보 1 (#4889): a reply in a followed thread. The Swift gate above is held equal
    // to this list, so the extension and the lock-screen action accept it exactly when JS does.
    expect(PUSH_REASONS).toContain('thread_reply');
  });

  it('renders work_run_done with fixed copy, never the agent reply (ADR-0162 D14)', () => {
    const branch = SWIFT.indexOf('envelope.reason == "work_run_done"');
    // #4316: the generic path now answers with the author too (`PushResolution`), so the search string is its display.
    const generic = SWIFT.indexOf('display: PushDisplayContent(title: author.displayName, body: body)');
    const decode = SWIFT.indexOf('decoder.decode(MessagePage.self');
    expect(branch).toBeGreaterThan(-1);
    // The branch returns before the page is decoded and before the generic
    // author-name + body path, so the reply text can never reach the lock screen.
    expect(branch).toBeLessThan(decode);
    expect(branch).toBeLessThan(generic);
    const returns = SWIFT.slice(branch, decode);
    expect(returns).toContain('PushWorkRunDoneCopy.display()');
    expect(returns).not.toMatch(/\.body|message\./);
    const copy = SWIFT.match(/enum PushWorkRunDoneCopy \{[\s\S]*?\n\}/);
    if (!copy) throw new Error('no PushWorkRunDoneCopy');
    expect(copy[0]).toContain('"요청한 작업이 끝났어요"');
  });

  it('registers under the app bundle id, never the extension bundle id', () => {
    // The APNs topic is the APP's bundle id. Sending the extension's would make
    // every push undeliverable — APNs rejects a topic no certificate covers.
    expect(PUSH_TOPIC).toBe('app.momo.ios');
  });
});

describe('the inherited Swift has not drifted from the frozen kit', () => {
  it('passes scripts/verify_push_kit_inheritance.sh', () => {
    // Run here as well as in CI so the failure surfaces in the same command a
    // person runs locally (`npm test`), not only in a lane they may not run.
    expect(() =>
      execFileSync(
        'bash',
        [join(APP_ROOT, '../../scripts/verify_push_kit_inheritance.sh')],
        {stdio: 'pipe'},
      ),
    ).not.toThrow();
  });
});

describe('entitlements — the app/extension asymmetry is deliberate', () => {
  const appEnt = readFileSync(
    join(IOS, 'MomoMobile/MomoMobile.entitlements'),
    'utf8',
  );
  const nseEnt = readFileSync(
    join(IOS, 'NotificationService/MomoMobileNotificationService.entitlements'),
    'utf8',
  );

  it('shares the keychain access group verbatim', () => {
    const group = '$(AppIdentifierPrefix)app.momo.ios.shared';
    expect(appEnt).toContain(`<string>${group}</string>`);
    expect(nseEnt).toContain(`<string>${group}</string>`);
  });

  it('shares the App Group verbatim', () => {
    expect(appEnt).toContain('<string>group.app.momo.ios</string>');
    expect(nseEnt).toContain('<string>group.app.momo.ios</string>');
  });

  it('gives aps-environment to the app and NOT to the extension', () => {
    // An extension is woken to rewrite a notification the host registered for;
    // it is not itself an APNs client. Declaring the capability on it demands an
    // entitlement its App ID never needs.
    // Matches the DECLARATION, not the word: the extension's file explains in a
    // comment why the key is absent, and a test that fails on the explanation
    // teaches the next person to delete the explanation.
    expect(appEnt).toContain('<key>aps-environment</key>');
    expect(nseEnt).not.toContain('<key>aps-environment</key>');
  });

  it('gives the communication-notification capability to the app and NOT to the extension (#4316)', () => {
    // Apple: "Enable the Communication Notifications capability in your app target". Buzz ships it the same way.
    // The extension donates inside the app's bundle; declaring it there too would ask the extension's App ID
    // for a capability it never needs (and the extension's profile has none). It is the KEY that is judged.
    const key = '<key>com.apple.developer.usernotifications.communication</key>';
    expect(appEnt).toContain(key);
    expect(appEnt).toMatch(/<key>com\.apple\.developer\.usernotifications\.communication<\/key>\s*<true\/>/);
    expect(nseEnt).not.toContain(key);
  });
});

describe('Info.plist carries what the runtime reads', () => {
  const plist = readFileSync(join(IOS, 'MomoMobile/Info.plist'), 'utf8');
  const nsePlist = readFileSync(join(IOS, 'NotificationService/Info.plist'), 'utf8');
  const pbxproj = readFileSync(
    join(IOS, 'MomoMobile.xcodeproj/project.pbxproj'),
    'utf8',
  );

  it('moves MomoAPNSEnvironment across from the frozen kit', () => {
    // audit §7.2 #9. Without this key the environment can only be guessed from
    // __DEV__, and a Release build signed with a development profile guesses
    // wrong — silently, because APNs simply drops the notification.
    expect(plist).toContain('<key>MomoAPNSEnvironment</key>');
    expect(plist).toContain('<string>$(APS_ENVIRONMENT)</string>');
  });

  it('defines APS_ENVIRONMENT for both configurations', () => {
    // The key above is only as good as the build setting behind it.
    expect(pbxproj).toContain('APS_ENVIRONMENT = development;');
    expect(pbxproj).toContain('APS_ENVIRONMENT = production;');
  });

  it('gives BOTH processes the keychain access group key', () => {
    // PushNotification.swift reads this key from whichever bundle it is running
    // in. The extension without it silently loses its access group; the app
    // without it cannot tell JS where to write.
    const key = '<key>MomoKeychainAccessGroup</key>';
    expect(plist).toContain(key);
    expect(nsePlist).toContain(key);
  });

  it('names the intent a communication notification donates, in the APP plist only (#4316)', () => {
    // Apple: "Add the class name of each intent that your app supports to the NSUserActivityTypes array in your
    // Info.plist". The app's plist, not the extension's.
    expect(plist).toMatch(
      /<key>NSUserActivityTypes<\/key>\s*<array>\s*<string>INSendMessageIntent<\/string>\s*<\/array>/,
    );
    expect(nsePlist).not.toContain('<key>NSUserActivityTypes</key>');
  });

  it('declares the background mode the id-only design depends on', () => {
    // The relay sends content-available alongside mutable-content
    // (PushDispatch.swift:112-113); without this the former is dropped.
    expect(plist).toContain('<string>remote-notification</string>');
  });

  it('points the extension at the right principal class', () => {
    expect(nsePlist).toContain(
      '<string>$(PRODUCT_MODULE_NAME).NotificationService</string>',
    );
    expect(nsePlist).toContain(
      '<string>com.apple.usernotifications.service</string>',
    );
  });
});

// =============================================================================
// #4316 (ADR-0204 증보 5) — 앱이 알림 확장에게 건네는 길의 JS ↔ Swift 계약.
//
// JS 는 네이티브 함수가 없으면 **아무 일도 하지 않는다**(`presentation.ts`: 모듈이 없는 빌드·옛 바이너리·시험).
// 그 관용이 이 계약의 약점이다: Swift 쪽 이름이 바뀌거나 JS 가 다른 이름을 부르면 어느 쪽도 던지지 않고,
// 사진·채널 이름이 영원히 건너가지 않는다 — 알림은 오고 「조금 못한 알림」일 뿐이라 아무도 모른다. 두 언어는
// 서로 컴파일되지 않으므로 이 시험이 이름을 맞댄다. (판정 자체 — 캐시 한도·사진 순서·계획 — 는 아래 sim-check 가 돌린다.)
// =============================================================================
describe('앱이 알림 확장에게 건네는 네이티브 함수 (JS 가 부르는 이름 = Swift 가 등록한 이름)', () => {
  const MODULE_SWIFT = readFileSync(
    join(APP_ROOT, 'modules/momo-push-native/ios/MomoPushNativeModule.swift'),
    'utf8',
  );
  const JS = readFileSync(join(APP_ROOT, 'src/push/presentation.ts'), 'utf8');

  /** 주석을 걷는다: 주석에 적힌 이름은 등록이 아니다. */
  const code = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('모듈 이름이 같다', () => {
    const swiftName = /\bName\("([^"]+)"\)/.exec(code(MODULE_SWIFT))?.[1];
    const jsName = /const MODULE_NAME = '([^']+)'/.exec(code(JS))?.[1];
    expect(swiftName).toBe('MomoPushNative');
    expect(jsName).toBe(swiftName);
  });

  it('JS 가 부르는 네 함수가 Swift 가 등록한 AsyncFunction 이름과 정확히 같다', () => {
    const registered = [...code(MODULE_SWIFT).matchAll(/AsyncFunction\("(\w+)"\)/g)].map(m => m[1]).sort();
    const interfaceBody = /interface PresentationNative \{([\s\S]*?)\n\}/.exec(code(JS))?.[1] ?? '';
    const called = [...interfaceBody.matchAll(/^\s{2}(\w+)\?\(/gm)].map(m => m[1]).sort();
    expect(registered).toEqual(['clearPresentation', 'exportAvatar', 'exportChannels', 'setPresentationSettings']);
    expect(called).toEqual(registered);
  });

  it('인자의 순서도 같다 (Swift 클로저의 이름 = JS 호출의 자리)', () => {
    const swift = code(MODULE_SWIFT);
    expect(swift).toMatch(/AsyncFunction\("setPresentationSettings"\) \{ \(previewEnabled: Bool, showSender: Bool\)/);
    expect(swift).toMatch(
      /AsyncFunction\("exportAvatar"\) \{\s*\(baseUrl: String, workspaceId: String, memberId: String, version: String, fileUri: String\)/,
    );
    expect(swift).toMatch(/AsyncFunction\("exportChannels"\) \{ \(baseUrl: String, workspaceId: String, channels: \[\[String: Any\]\]\)/);
    expect(swift).toMatch(/AsyncFunction\("clearPresentation"\) \{ \(promise: Promise\)/);
    const js = code(JS);
    expect(js).toMatch(/module\.setPresentationSettings\(isPushPreviewOn\(\), isPushShowSenderOn\(\)\)/);
    expect(js).toMatch(/module\.exportAvatar\(baseUrl, found\[1\], found\[2\], found\[3\], fileUri\)/);
    expect(js).toMatch(/module\.exportChannels\(absoluteApiBase\(\), workspaceId, channels\)/);
  });

  it('Swift 가 읽는 채널 항목의 키가 JS 가 싣는 키와 같다 (id · kind · name · memberCount)', () => {
    const bridge = readFileSync(
      join(APP_ROOT, 'modules/momo-push-native/ios/MomoPushPresentationBridge.swift'),
      'utf8',
    );
    for (const key of ['id', 'kind', 'name', 'memberCount']) {
      expect(bridge).toContain(`entry["${key}"]`);
      expect(JS).toMatch(new RegExp(`\\b${key}\\??:`));
    }
    for (const kind of ['public', 'private', 'dm']) {
      expect(JS).toContain(`'${kind}'`);
    }
  });
});

// =============================================================================
// Swift 쪽 판정을 **실제로 컴파일해 돌린다** — 위의 이름 맞댐은 글자일 뿐이고, 캐시 한도·사진 순서·무엇을 어떻게
// 보여 줄지(계획)·REST 해석·정리 재시도는 컴파일된 코드만이 증명한다. 알림 확장과 앱 모듈이 컴파일하는 바로 그
// 파일들(`MomoPushPresentationStore.swift`·`PushNotification.swift`·`PushCommunication.swift`)을 `main.swift` 와
// 함께 `swiftc` 로 빌드해 이 Mac 에서 돌린다(`sim-check/run.sh`, 인자 없음). macOS 가 아니면(리눅스 CI) 건너뛴다.
// Intents 는 macOS 에 없으므로(`setImage(_:forParameterNamed:)`) 그 절반은 시뮬레이터에서만 돈다
// (`run.sh <udid>`): 실행한 기록은 PR 본문에 있다.
// =============================================================================
const onMac = process.platform === 'darwin';
(onMac ? describe : describe.skip)('Swift 쪽 알림 표시 판정 (macOS 에서 컴파일해 실행)', () => {
  it('sim-check 가 PASS 한다 — 설정·캐시·사진 순서·REST 해석·계획·정리 재시도', () => {
    let output = '';
    try {
      output = execFileSync('bash', [join(APP_ROOT, 'modules/momo-push-native/sim-check/run.sh')], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 150_000,
      });
    } catch (failure) {
      const error = failure as {stdout?: string; stderr?: string};
      throw new Error(`sim-check failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
    }
    expect(output).toMatch(/^PASS$/m);
    expect(output).not.toMatch(/^FAIL:/m);
    // 검사 수가 크게 줄었다면 누군가 검사를 지운 것이다. (#4316 이 213건으로 시작했다: 하한 190)
    expect((output.match(/^ok:/gm) ?? []).length).toBeGreaterThanOrEqual(190);
  }, 180_000);
});
