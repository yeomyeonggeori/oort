import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  PUSH_ACTION,
  PUSH_ACTION_KEYCHAIN_SERVICE,
  PUSH_ACTION_NATIVE_MODULE,
  PUSH_ACTION_SESSION_ACCOUNT,
  PUSH_CATEGORY,
  PUSH_ENVELOPE_SCHEMA,
  PUSH_REASONS,
} from '../src/push/contract';
import {APP_ONLY_KEYCHAIN_ACCESS_GROUP} from '../src/storage/keychainGroups';

// =============================================================================
// #3931 — 잠금 화면 승인을 받는 네이티브 처리기와 JS 는 서로를 import 하지 않는 두 쪽이다.
// 문자열로만 맞물리고, 어긋나도 **어디서도 오류가 나지 않는다**: 키체인 항목은 그냥 안
// 찾아지고(「…하지 못했어요」, 앱에서 마무리), 버튼은 그냥 JS 로 넘어간다. 그래서 이 파일이 Swift
// 소스를 읽어 맞춰 본다 — `pushContract.test.ts` 가 알림 확장에 하는 일과 같다.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const MODULE = join(APP_ROOT, 'modules/momo-push-action-native');
const read = (path: string) => readFileSync(path, 'utf8');
const swift = (name: string) => read(join(MODULE, 'ios', name));
const CORE = swift('MomoPushActionCore.swift');
const HANDLER = swift('MomoPushActionHandler.swift');
const KEYCHAIN = swift('MomoPushActionKeychain.swift');
const JOB = swift('MomoPushActionJob.swift');
const MODULE_SWIFT = swift('MomoPushActionNativeModule.swift');

/** `/* … */` 와 `// …` 를 걷어 낸다 — 설명이 금지한 API 의 이름을 말하는 것은 금지가 아니다. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/[^:"]\/\/.*$/gm, '');

/** 디렉터리 아래의 ts/tsx 파일들. */
function sourceTree(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceTree(full, acc);
    else if (/\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** `static let <name> = "<value>"` 한 줄에서 값을 꺼낸다. */
function constant(source: string, name: string): string {
  const match = source.match(new RegExp(`static let ${name}\\s*=\\s*"([^"]+)"`));
  if (!match) throw new Error(`no Swift constant named ${name}`);
  return match[1];
}

describe('같은 키체인 항목을 가리킨다 (JS 가 쓰고 Swift 가 읽는다)', () => {
  it('서비스와 계정이 같다', () => {
    expect(PUSH_ACTION_KEYCHAIN_SERVICE).toBe(constant(CORE, 'keychainService'));
    expect(PUSH_ACTION_SESSION_ACCOUNT).toBe(constant(CORE, 'sessionAccount'));
  });

  it('확장이 읽는 항목(app.momo.ios.session)과 서비스가 겹치지 않는다', () => {
    expect(PUSH_ACTION_KEYCHAIN_SERVICE).not.toBe('app.momo.ios.session');
    expect(constant(CORE, 'keychainService')).not.toBe(constant(read(join(APP_ROOT, 'ios/MomoPushKit/PushNotification.swift')), 'secureSessionService'));
  });

  it('Swift 가 읽는 그룹은 앱 전용 그룹이다 — 확장이 읽는 그룹이 아니다', () => {
    expect(constant(CORE, 'accessGroupSuffix')).toBe(APP_ONLY_KEYCHAIN_ACCESS_GROUP);
    expect(constant(CORE, 'accessGroupInfoKey')).toBe('MomoDeviceKeyAccessGroup');
    // 확장의 키(MomoKeychainAccessGroup)는 이 모듈 어디에도 없다.
    expect(code(CORE) + code(KEYCHAIN) + code(HANDLER)).not.toContain('MomoKeychainAccessGroup');
    // 그리고 그 plist 키는 앱에만 있고 확장에는 없다.
    expect(read(join(APP_ROOT, 'ios/MomoMobile/Info.plist'))).toContain('<key>MomoDeviceKeyAccessGroup</key>');
    expect(read(join(APP_ROOT, 'ios/NotificationService/Info.plist'))).not.toContain('MomoDeviceKeyAccessGroup');
  });

  it('JS 가 쓰는 JSON 의 키가 Swift 가 디코드하는 키를 모두 담는다 (대소문자까지)', () => {
    const wire = CORE.match(/private struct Wire: Decodable \{([\s\S]*?)\n {2}\}/);
    if (!wire) throw new Error('no Wire struct in MomoPushActionSession');
    const swiftKeys = [...wire[1].matchAll(/let (\w+):/g)].map(m => m[1]);
    expect(swiftKeys.sort()).toEqual(['actionToken', 'baseURL', 'expiresAtMs', 'workspaceID']);

    const jsSource = read(join(APP_ROOT, 'src/push/pushActionSession.ts'));
    const payload = jsSource.match(/interface PushActionSessionPayload \{([\s\S]*?)\n\}/);
    if (!payload) throw new Error('no PushActionSessionPayload');
    const jsKeys = [...payload[1].matchAll(/^\s+(\w+):/gm)].map(m => m[1]);
    for (const key of swiftKeys) expect(jsKeys).toContain(key);
    // 이쪽 장부 둘은 Swift 가 무시한다.
    expect(jsKeys.sort()).toEqual(['actionToken', 'baseURL', 'expiresAtMs', 'memberID', 'ttlSeconds', 'workspaceID']);
  });

  // react-native-keychain 의 `setGenericPassword`/`resetGenericPassword` 는 **서비스 단위로** 그룹 안의
  // 항목을 전부 지우고(계정은 보지 않는다, RNKeychainManager.m), `getGenericPassword` 에도 계정 필터가
  // 없다. 기기 비밀이 JS 가 쓰는 서비스에 있으면 토큰을 놓을 때마다 비밀이 사라진다 — 독립 보안 검수
  // 1번이 잡았고, 시험용 키체인이 서비스를 키로 삼아 이 입자로는 보이지 않던 것이다.
  it('기기 비밀은 JS 가 쓰는 것과 **다른 서비스**에 있다 (JS 의 쓰기·지우기가 서비스 전체를 지운다)', () => {
    const secretService = constant(CORE, 'deviceSecretService');
    expect(secretService).not.toBe(PUSH_ACTION_KEYCHAIN_SERVICE);
    expect(secretService).not.toBe(constant(CORE, 'keychainService'));
    expect(constant(CORE, 'deviceSecretAccount')).not.toBe(PUSH_ACTION_SESSION_ACCOUNT);
    // 읽는 쪽이 각자의 서비스로 질의한다.
    const keychain = code(KEYCHAIN);
    expect(keychain).toMatch(/service:\s*MomoPushActionContract\.deviceSecretService/);
    expect(keychain).toMatch(/service:\s*MomoPushActionContract\.keychainService/);
    // 주석은 걷고 본다 — 지우기 쪽 설명이 그 이름을 말하는 것은 쓰는 것이 아니다.
    const js = code(read(join(APP_ROOT, 'src/push/pushActionSession.ts')));
    expect(js).not.toContain('device-secret');
    expect(js).not.toContain(secretService);
    // 다른 어떤 JS 도 이 서비스를 가리키지 않는다.
    const offenders = sourceTree(join(APP_ROOT, 'src')).filter(file => read(file).includes(secretService));
    expect(offenders).toEqual([]);
  });
});

describe('같은 알림 어휘를 읽는다 (처리기는 JS 와 확장만큼 엄격하다)', () => {
  it('버튼·카테고리·스키마 문자열이 JS 와 같다', () => {
    expect(constant(CORE, 'approveAction')).toBe(PUSH_ACTION.approve);
    expect(constant(CORE, 'rejectAction')).toBe(PUSH_ACTION.reject);
    expect(constant(CORE, 'approvalCategory')).toBe(PUSH_CATEGORY.approval);
    expect(constant(CORE, 'envelopeSchema')).toBe(PUSH_ENVELOPE_SCHEMA);
  });

  it('이유 어휘가 JS·확장과 정확히 같다 (부분집합이 아니다)', () => {
    const list = CORE.match(/static let reasons: Set<String> = \[([\s\S]*?)\]/);
    if (!list) throw new Error('no reasons list in the Swift core');
    const swiftReasons = [...list[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
    expect(swiftReasons).toEqual([...PUSH_REASONS]);
    // 확장과도 같다.
    const extension = read(join(APP_ROOT, 'ios/MomoPushKit/PushNotification.swift'));
    const gate = extension.match(/\[((?:"[a-z_]+",?\s*)+)\]\.contains\(payload\.reason\)/);
    if (!gate) throw new Error('no reason gate in the extension');
    expect([...gate[1].matchAll(/"([a-z_]+)"/g)].map(m => m[1])).toEqual(swiftReasons);
  });

  it('릴레이 자리표시(제목·본문)가 확장과 같다 — 「승인했어요 · oort」를 만들지 않고, 모르는 알림을 승인하지 않으려고', () => {
    const extension = read(join(APP_ROOT, 'ios/MomoPushKit/PushNotification.swift'));
    expect(constant(CORE, 'placeholderTitle')).toBe(constant(extension, 'placeholderTitle'));
    expect(constant(CORE, 'placeholderBody')).toBe(constant(extension, 'placeholderBody'));
  });

  it('결과 줄이 원문을 싣는 키가 JS 가 읽는 키다', () => {
    expect(constant(CORE, 'originKey')).toBe('origin');
    const envelope = read(join(APP_ROOT, 'src/push/envelope.ts'));
    expect(envelope).toContain('{origin?: unknown}');
    expect(envelope).toMatch(/data\?\.origin/);
  });
});

describe('JS 가 처리기를 알아보는 이름', () => {
  it('모듈 이름과 상수 이름이 Swift 와 같다', () => {
    expect(MODULE_SWIFT).toContain(`Name("${PUSH_ACTION_NATIVE_MODULE}")`);
    expect(MODULE_SWIFT).toContain('Constant("handlesApprovalActions")');
    expect(read(join(APP_ROOT, 'src/push/native.ts'))).toContain('handlesApprovalActions');
  });

  it('상수는 처리기가 실제로 붙었는지를 말한다 — 모듈이 링크됐다는 뜻이 아니다', () => {
    expect(code(MODULE_SWIFT)).toContain('MomoPushActionInstaller.isInstalled');
    const installed = code(
      HANDLER.slice(HANDLER.indexOf('public static var isInstalled'), HANDLER.indexOf('public static func install()')),
    );
    // 처리기를 목록에 넣었다는 것 …
    expect(installed).toMatch(/state\.handler != nil/);
    // … 그리고 expo 가 UNUserNotificationCenter.delegate 를 실제로 잡고 있다는 것. 다른 것이 먼저 잡았으면 expo 는
    // 물러나고(NotificationCenterManager.swift:51-60) 목록은 아무도 부르지 않는다 — 그때 JS 가 물러나면 버튼이 죽는다.
    expect(installed).toMatch(/UNUserNotificationCenter\.current\(\)\.delegate[^\n]*===\s*NotificationCenterManager\.shared/);
  });

  it('autolinking 이 이 모듈을 찾고, 알림 쪽 의존이 선언돼 있다', () => {
    const config = JSON.parse(read(join(MODULE, 'expo-module.config.json')));
    expect(config.apple.modules).toEqual(['MomoPushActionNativeModule']);
    const podspec = read(join(MODULE, 'ios/MomoPushActionNative.podspec'));
    expect(podspec).toContain("s.dependency 'ExpoModulesCore'");
    expect(podspec).toContain("s.dependency 'ExpoNotifications'");
    // 시뮬레이터 점검은 podspec 이 링크하는 ios/ 밖에 있어 앱에 들어가지 않는다.
    expect(podspec).toContain("s.source_files = '**/*.{h,m,mm,swift}'");
    // Podfile.lock 이 이 포드를 안다.
    expect(read(join(APP_ROOT, 'ios/Podfile.lock'))).toContain('MomoPushActionNative (1.0.0)');
  });
});

describe('처리기가 지키는 규율', () => {
  it('AppDelegate 가 React Native 를 시작하기 전에 처리기를 붙인다', () => {
    const appDelegate = read(join(APP_ROOT, 'ios/MomoMobile/AppDelegate.swift'));
    const install = appDelegate.indexOf('MomoPushActionInstaller.install()');
    const start = appDelegate.indexOf('factory.startReactNative(');
    const factory = appDelegate.indexOf('ExpoReactNativeFactory(delegate:');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(factory);
    expect(install).toBeLessThan(start);
    // ExpoModulesProvider 가 이 모듈을 internal 로 import 하므로 같은 수준이어야 빌드된다.
    expect(appDelegate).toMatch(/^internal import MomoPushActionNative$/m);
  });

  it('didReceive 는 동기로 일을 시작하고 완료 핸들러는 부르지 않는다 — 시간 잡기가 호출 스택 밖으로 밀려나지 않는다', () => {
    const body = HANDLER.slice(
      HANDLER.indexOf('public func didReceive('),
      HANDLER.indexOf('/// What AppDelegate calls.'),
    );
    expect(body).toContain('MomoPushActionJob(');
    expect(body).toContain('.start()');
    // 백그라운드 시간은 `didReceive` 안에서, 아무것도 기다리기 **전에** 잡아야 한다. 처리기 본문에 비동기가
    // 한 글자라도 끼면(`Task {`, `DispatchQueue`, `async`, `await`) 시간을 잡는 줄이 호출 스택 밖으로 밀려나
    // 그 사이 완료 핸들러가 불린 뒤에 잡게 된다 — 보안 검수가 첫 구현에서 잡은 결함이다.
    expect(code(body)).not.toMatch(/\b(?:Task|DispatchQueue|async|await|Thread|OperationQueue)\b/);
    // 승인·거절만 `true`, 나머지는 `false` — 본문 탭이 콜드 런치에서 EmitterModule 로 가는 길을 먹지 않는다.
    expect(body).toMatch(/guard let intent = MomoPushActionIntent\(response: response\) else \{ return false \}/);
    expect(body.match(/return true/g)).toHaveLength(1);
    // 완료는 NotificationCenterManager 가 부른다 — 두 번 부르지 않는다.
    expect(code(HANDLER)).not.toMatch(/completionHandler\s*\(\s*\)/);
    expect(code(JOB)).not.toMatch(/completionHandler/);
  });

  it('시간을 일보다 먼저 잡고, 시간이 다하면 결과를 먼저 가로챈 뒤 취소하고, 작업은 한 번만 끝낸다', () => {
    const job = code(JOB);
    // `start()`: 시간을 잡는 호출이 일을 띄우는 `Task {` 보다 앞선다.
    const start = job.slice(job.indexOf('func start()'), job.indexOf('func waitForCompletion()'));
    expect(start).toContain('tasks.begin(');
    expect(start.indexOf('tasks.begin(')).toBeGreaterThan(-1);
    expect(start.indexOf('tasks.begin(')).toBeLessThan(start.indexOf('Task {'));
    // `begin` 이 돌아오기 전에 만료 핸들러가 먼저 돌 수 있다 — 끝내 달라는 요청은 기억돼서 토큰이 생기는 즉시 지켜진다.
    expect(job).toContain('endRequested');
    // `timeRanOut()`: 결과를 가로챈 **뒤에** 취소한다(취소가 요청을 깨워 꼬리가 같은 줄을 쓰려 달려든다).
    const ran = job.slice(job.indexOf('private func timeRanOut()'), job.indexOf('private func claimResult()'));
    expect(ran.indexOf('claimResult()')).toBeGreaterThan(-1);
    expect(ran.indexOf('claimResult()')).toBeLessThan(ran.indexOf('.cancel()'));
    expect(ran).toContain('postWithoutWaiting(');
    expect(ran).toContain('endBackgroundTask()');
    // 끝내기는 한 번: 이미 끝냈다는 표시가 있다.
    const end = job.slice(job.indexOf('private func endBackgroundTask()'));
    expect(end).toContain('backgroundTaskEnded');
    expect(end).toContain('tasks.end(');
    // 일이 끝나면(`run()`) 줄을 쓴 뒤 작업을 끝낸다.
    const run = job.slice(job.indexOf('private func run()'), job.indexOf('private func timeRanOut()'));
    expect(run).toContain('claimResult()');
    expect(run.indexOf('notifier.apply(')).toBeLessThan(run.indexOf('endBackgroundTask()'));
  });

  it('UIApplication 은 두 줄 이음새 뒤에만 있다 — 실제 어댑터는 시간 잡기·끝내기 그대로다', () => {
    const adapter = HANDLER.slice(
      HANDLER.indexOf('struct MomoPushActionUIKitTasks'),
      HANDLER.indexOf('// MARK: - the delegate'),
    );
    expect(adapter).toContain('UIApplication.shared.beginBackgroundTask(withName: name, expirationHandler: expiration)');
    expect(adapter).toContain('UIApplication.shared.endBackgroundTask(');
    // 어댑터는 UIKit 이 준 것을 그대로 돌려준다: 받은 식별자(`.invalid` 이면 nil)를, 끝낼 때는 받은 토큰을. 가짜 토큰을
    // 돌려주고 호출을 미루거나(`DispatchQueue.main.async`) 다른 식별자로 끝내는 어댑터는 시간 잡기를 헛돌게 한다 —
    // sim-check 는 이 어댑터를 못 돌리므로(UIKit) 글자로 고정한다 (보안 검수 3차 Low 2).
    const adapterCode = code(adapter);
    expect(adapterCode).toMatch(/let id = Self\.onMain \{\s*UIApplication\.shared\.beginBackgroundTask\(withName: name, expirationHandler: expiration\)\s*\}/);
    expect(adapterCode).toContain('return id == .invalid ? nil : id.rawValue');
    expect(adapterCode).toContain('UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: token))');
    expect(adapterCode).not.toMatch(/\.async\b|\basyncAfter\b|\bTask\b|\basync\b|\bawait\b/);
    // 작업 이음새와 알림 이음새가 코어/잡 파일의 프로토콜이다.
    expect(code(JOB)).toMatch(/protocol MomoPushActionBackgroundTasks: Sendable/);
    expect(code(JOB)).toMatch(/protocol MomoPushActionNotifying: Sendable/);
    // 잡 파일은 UIKit 을 모른다 — sim-check 가 가짜로 돌릴 수 있는 까닭이다.
    expect(code(JOB)).not.toMatch(/import\s+(?:UIKit|UserNotifications|ExpoNotifications)/);
    expect(code(CORE)).not.toMatch(/import\s+(?:UIKit|UserNotifications|ExpoNotifications)/);
  });

  it('승인·거절이 아닌 응답과 승인 카테고리가 아닌 알림은 만지지 않는다', () => {
    const intent = HANDLER.slice(HANDLER.indexOf('init?(response: UNNotificationResponse)'), HANDLER.indexOf('struct MomoPushActionNotifier'));
    expect(intent).toContain('MomoPushActionDirection(actionIdentifier: response.actionIdentifier)');
    expect(intent).toContain('content.categoryIdentifier == MomoPushActionContract.approvalCategory');
    expect(intent.match(/return nil/g)).toHaveLength(2);
    // 릴레이가 보낸 알림 문구는 **페이로드에서** 읽어 확장이 덮어쓴 글과 견준다 — 이 줄이 빠지면 처리기는 「oort / 새 알림」
    // 한 쌍만 자리표시로 알아본다(릴레이가 문구를 바꾸는 날 모르는 알림을 승인하게 된다).
    expect(intent).toContain('relayAlert: MomoPushActionRelayAlert.read(userInfo: userInfo)');
  });

  it('요청은 리다이렉트를 따라가지 않고 쿠키·캐시를 쓰지 않는다 (bearer 가 그 요청에만 머문다)', () => {
    const transport = HANDLER.slice(HANDLER.indexOf('final class MomoPushActionURLSessionTransport'), HANDLER.indexOf('// MARK: - the notification centre'));
    expect(transport).toContain('URLSessionConfiguration.ephemeral');
    expect(transport).toContain('configuration.httpCookieStorage = nil');
    expect(transport).toContain('configuration.urlCache = nil');
    expect(transport).toMatch(/willPerformHTTPRedirection[\s\S]*completionHandler\(nil\)/);
  });

  it('토큰·응답 본문·식별자를 로그에 쓰지 않는다 (처리기·잡 두 파일의 모든 로그)', () => {
    const sources = code(HANDLER) + '\n' + code(JOB);
    const logs = [...sources.matchAll(/logger\.\w+\(\s*"([^"]*)"/g)].map(m => m[1]);
    // 로그가 실제로 있다(검사가 헛돌지 않는다).
    expect(logs.length).toBeGreaterThanOrEqual(5);
    const logged = logs.join('\n');
    expect(logged).toContain('[push] action');
    expect(logged).not.toMatch(/token|secret|body|approval|workspace|bearer/i);
    // 그 로그 문장에 보간되는 값은 방향과 결과 이름뿐이다.
    const interpolated = [...sources.matchAll(/logger\.\w+\([\s\S]*?\)\s*\n/g)].map(m => m[0]).join('\n');
    for (const value of interpolated.matchAll(/\\\(([^)]*?)(?:,|\))/g)) {
      expect(value[1]).toMatch(/direction\.approved|outcome\.logName/);
    }
  });

  it('토큰을 JS 로 돌려주는 길이 모듈에 없다', () => {
    // JS 가 보는 것은 불리언 하나뿐이다.
    expect(code(MODULE_SWIFT)).not.toMatch(/AsyncFunction|Function\(/);
    expect(code(MODULE_SWIFT).match(/Constant\(/g)).toHaveLength(1);
  });
});

describe('잠금 화면에 올라가는 글', () => {
  // 디자인 시스템은 줄표(em dash)를 아예 금지한다(docs/design-system/README.md, 웹 SKILL §7). 그 점검은
  // 전부 JS/TS 소스를 걷는다 — Swift 가 만드는 문자열(이 처리기와 알림 확장)은 아무것도 재지 않아서
  // 사람이 눈으로 볼 수밖에 없다(#3931 디자인 리뷰 H1). 이 시험이 그 빈자리를 막는다.
  const swiftFiles = [
    ...readdirSync(join(MODULE, 'ios')).filter(name => name.endsWith('.swift')).map(name => join(MODULE, 'ios', name)),
    join(APP_ROOT, 'ios/MomoPushKit/PushNotification.swift'),
    join(APP_ROOT, 'ios/MomoPushKit/PushCommunication.swift'),
    join(APP_ROOT, 'ios/NotificationService/NotificationService.swift'),
    join(APP_ROOT, 'modules/momo-push-native/ios/MomoPushPresentationStore.swift'),
  ];

  it('Swift 코드(주석 제외)의 어떤 문자열에도 em dash(U+2014)·en dash(U+2013)가 없다', () => {
    const offenders = swiftFiles.filter(file => /[\u2013\u2014]/.test(code(read(file))));
    expect(offenders).toEqual([]);
    // 검사가 헛돌지 않는다: 주석에는 줄표가 있고(여기서 걷어 낸다), 파일들은 실제로 읽혔다.
    expect(swiftFiles.length).toBeGreaterThanOrEqual(9);
    expect(read(join(MODULE, 'ios/MomoPushActionCore.swift'))).toMatch(/[\u2013\u2014]/);
  });

  it('실패의 다음 행동은 본문으로 간다 — 한 줄 제목의 끝이 잘리면 가장 중요한 말이 사라진다', () => {
    expect(code(HANDLER)).toContain('content.body = notice.body');
    expect(code(CORE)).toContain('body: line.detail ?? ""');
    expect(code(CORE)).toContain('static let failedDetail = "눌러서 앱에서 마무리해 주세요"');
  });
});

describe('이 자격은 알림 확장이 읽는 곳에 닿지 않는다', () => {
  const session = code(read(join(APP_ROOT, 'src/push/pushActionSession.ts')));
  const provider = code(read(join(APP_ROOT, 'src/push/PushProvider.tsx')));

  it('JS 는 앱 전용 그룹에서만 읽고 쓰고 지운다 — 그룹은 하나의 함수에서만 정해진다', () => {
    // 그룹이 `appOnlyGroupFrom(…)` 을 거쳐서만 나온다.
    expect(session.match(/appOnlyGroupFrom\(keychainAccessGroup\(\)\)/g)).toHaveLength(1);
    // 공유 그룹 이름이나 그 값을 accessGroup 으로 곧바로 대는 곳이 없다.
    expect(session).not.toContain('NSE_KEYCHAIN_ACCESS_GROUP');
    expect(session).not.toMatch(/accessGroup:\s*keychainAccessGroup/);
    // 모든 키체인 호출이 그 함수의 결과를 쓴다.
    const calls = [...session.matchAll(/(?:setGenericPassword|getGenericPassword|resetGenericPassword)\(/g)];
    expect(calls).toHaveLength(3);
    expect([...session.matchAll(/\baccessGroup\b(?!\s*[):,=])/g)].length).toBeGreaterThanOrEqual(0);
    expect(session.match(/accessGroup,?\s*\}/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('그룹을 못 정하면 쓰기 전에 돌아선다', () => {
    const publish = session.slice(session.indexOf('export async function publishPushActionSession'));
    expect(publish.indexOf("kind: 'no-access-group'")).toBeGreaterThan(-1);
    expect(publish.indexOf("kind: 'no-access-group'")).toBeLessThan(publish.indexOf('setGenericPassword('));
  });

  // 자격을 받아 놓는 효과 하나만 떼어 본다(주석을 걷은 코드에서 키퍼를 만드는 곳부터 의존 배열까지).
  const effect = (() => {
    const from = provider.indexOf('createPushFetchKeeper<MintedPushActionToken>(');
    const to = provider.indexOf('[workspaceId, memberId, actionCredential]);', from);
    if (from < 0 || to < 0) throw new Error('the push_action effect moved — update this slice');
    return provider.slice(from, to);
  })();

  it('PushProvider 는 세션의 access·refresh 토큰을 이 자격 쪽으로 넘기지 않는다', () => {
    expect(effect).toContain('mint: mintPushActionToken');
    expect(effect).toContain('publishPushActionSession(');
    // 세션이 있는지 묻기만 한다(`getAccessToken() !== null`), 값을 넘기지 않는다.
    expect(effect.match(/getAccessToken\(\)/g)).toHaveLength(1);
    expect(effect).toContain('getAccessToken() !== null');
    expect(effect).not.toMatch(/getRefreshToken|refreshToken/);
    // 놓는 값은 키퍼가 넘긴 토큰이다.
    expect(effect).toMatch(/publish: async \(token, minted\)/);
    expect(effect).toMatch(/token,\s*\n\s*expiresAtMs: minted\.expiresAtMs/);
  });

  it('토큰 값은 이 자격의 어느 로그에도 적히지 않는다', () => {
    const logs = [...(session + effect).matchAll(/console\.(?:log|warn|error)\([\s\S]*?\);/g)].map(m => m[0]).join('\n');
    expect(logs).toContain('lock-screen approval credential');
    expect(logs).not.toMatch(/\$\{(?:token|actionToken|input\.token|minted\.token)\b/);
    expect(logs).not.toContain('actionToken');
  });
});

// =============================================================================
// Swift 쪽 판정을 **실제로 컴파일해 돌린다.** 위의 시험들은 Swift 소스를 글자로 읽을 뿐이고,
// 멱등 키의 값·응답 해석·문장·키체인 논리는 컴파일된 코드만이 증명한다. 모듈의 UIKit 없는 절반
// (`MomoPushActionCore/DecisionKey/Keychain/Job`)을 `sim-check/main.swift` 와 함께 `swiftc` 로 빌드해
// 이 Mac 에서 돌린다(`sim-check/run.sh`, 기본 인자 없음). macOS 가 아니면(리눅스 CI) 건너뛴다.
// =============================================================================
const onMac = process.platform === 'darwin';
(onMac ? describe : describe.skip)('Swift 쪽 판정 (macOS 에서 컴파일해 실행)', () => {
  it('sim-check 가 PASS 한다 — 멱등 키 벡터, 페이로드·자격 읽기, 요청, 응답 해석, 문장, 키체인 논리, 백그라운드 시간 잡의 순서', () => {
    let output = '';
    try {
      output = execFileSync('bash', [join(MODULE, 'sim-check/run.sh')], {
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
    // 검사 수가 크게 줄었다면 누군가 검사를 지운 것이다. (#4294 가 알림 확장의 첨부 본문·승인 알림 가드·지워진 메시지 33건을 더했다: 하한 270 → 330)
    expect((output.match(/^ok:/gm) ?? []).length).toBeGreaterThanOrEqual(330);
  }, 180_000);
});

describe('NSE: 본문을 못 채운 승인은 「열어서 결정」으로 낮춘다 (ADR-0204 D7)', () => {
  const NSE = read(join(APP_ROOT, 'ios/NotificationService/NotificationService.swift'));

  it('어느 길로 끝나든 먼저 낮추고, 채워졌을 때만 원래 카테고리로 되돌린다', () => {
    const body = code(NSE);
    // fail-open(세션·봉투 없음)도 이 낮춤을 지난다: 낮춤이 guard 보다 앞선다.
    expect(body.indexOf('MomoPushCategoryDemotion.categoryIdentifier(')).toBeGreaterThan(-1);
    expect(body.indexOf('MomoPushCategoryDemotion.categoryIdentifier(')).toBeLessThan(body.indexOf('guard let envelope'));
    expect(body).toMatch(/if resolved \{\s*updated\.categoryIdentifier = originalCategory/);
    expect(body).toMatch(/let resolved = display\.title != fallback\.title \|\| display\.body != fallback\.body/);
  });

  // #4316: 미리보기·보낸 사람 표시를 끈 알림은 본문이 「새 메시지」라서 `resolved` 가 참이어도 무엇인지 말하지 않는다.
  // 서버가 승인 카테고리를 메시지 이유와 짝지어 보내면(파서는 둘을 묶지 않는다) 위 되돌림이 승인·거절 단추를 되살린다.
  // 그 줄은 확장(컴파일되지 않는 쪽)에만 있어서 `sim-check` 가 못 잰다 — 순서와 조건을 글자로 못박는다.
  it('글을 숨긴 알림은 단추를 되돌린 **뒤에** 다시 낮춘다 (ADR-0204 D7, 미리보기·보낸 사람 표시)', () => {
    const body = code(NSE);
    const restore = body.search(/if resolved \{\s*updated\.categoryIdentifier = originalCategory/);
    const again = body.indexOf('if !result.presentation.showsResolvedText');
    expect(restore).toBeGreaterThan(-1);
    expect(again).toBeGreaterThan(restore);
    expect(body.slice(again)).toMatch(
      /MomoPushCategoryDemotion\.categoryIdentifier\(\s*current: updated\.categoryIdentifier, resolved: false\)/,
    );
  });
});
