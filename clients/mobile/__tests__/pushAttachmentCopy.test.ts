import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  ATTACH_PREVIEW_COPY,
  attachmentPreviewLine,
} from '@momo/core/features/attachments/model';

// =============================================================================
// #4294 - 글 없이 사진만 보낸 메시지의 푸시 본문.
//
// 푸시 본문은 서버가 쓰지 않는다. relay 는 「새 알림」 자리표시만 보내고, 알림 확장(Swift)이 REST 로
// 메시지를 읽어 다시 쓴다(ADR-0204). 그 확장이 본문이 빈 메시지를 던져 「oort / 새 알림」으로 떨어졌다.
// 고친 Swift(`PushAttachmentCopy`)는 코어 `attachmentPreviewLine` 과 **같은 문장**을 내야 한다 - 목록·배너·
// 푸시가 한 말을 해야 하기 때문이다. 두 언어가 따로 컴파일되니 이 시험이 둘을 맞댄다:
//
//   1. Swift 의 문구 틀(「사진 \(count)장」 …)이 코어 문구표가 찍는 글과 같다.
//   2. Swift `sim-check` 가 실제로 돌리는 벡터를 코어 함수에 그대로 먹여 같은 답이 나온다.
//
// Swift 쪽 동작 자체(REST 읽기·디코드·선택)는 컴파일해 돌리는 `sim-check` 가 증명한다
// (`pushActionContract.test.ts` 가 macOS 에서 돌린다). 여기는 두 쪽이 **같은 표를 읽는지**만 본다.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const SWIFT = readFileSync(join(APP_ROOT, 'ios/MomoPushKit/PushNotification.swift'), 'utf8');
const SIM_CHECK = readFileSync(
  join(APP_ROOT, 'modules/momo-push-action-native/sim-check/main.swift'),
  'utf8',
);

/** `public static func <name>(_ count: Int) -> String { "<앞>\(count)<뒤>" }` 의 앞·뒤. */
function swiftTemplate(name: string): {before: string; after: string} {
  const match = SWIFT.match(
    new RegExp(
      `static func ${name}\\(_ count: Int\\) -> String \\{ "([^"\\\\]*)\\\\\\(count\\)([^"\\\\]*)" \\}`,
    ),
  );
  if (!match) throw new Error(`no Swift template named ${name}`);
  return {before: match[1], after: match[2]};
}

describe('Swift 알림 확장의 첨부 문구는 코어 문구표와 같은 말이다', () => {
  it.each([1, 2, 3, 12])('개수 %i 에서 사진·파일 틀이 코어와 같다', count => {
    const photos = swiftTemplate('photos');
    const files = swiftTemplate('files');
    expect(`${photos.before}${count}${photos.after}`).toBe(ATTACH_PREVIEW_COPY.photos(count));
    expect(`${files.before}${count}${files.after}`).toBe(ATTACH_PREVIEW_COPY.files(count));
  });

  it('섞일 때 잇는 글자가 코어와 같다', () => {
    const match = SWIFT.match(/enum PushAttachmentCopy \{[\s\S]*?static let separator = "([^"]*)"/);
    if (!match) throw new Error('no separator in PushAttachmentCopy');
    expect(match[1]).toBe(ATTACH_PREVIEW_COPY.separator);
  });

  it('sim-check 가 돌리는 벡터를 코어 함수에 먹이면 같은 답이다', () => {
    const vectors = [
      ...SIM_CHECK.matchAll(/C\.line\(mimeTypes: \[([^\]]*)\]\) == (nil|"([^"]*)")/g),
    ];
    // 벡터가 지워졌다면 두 쪽이 같은 표를 읽는다는 말이 빈말이 된다.
    expect(vectors.length).toBeGreaterThanOrEqual(8);
    for (const [, mimeList, expectedRaw, expectedText] of vectors) {
      const mimes = [...mimeList.matchAll(/"([^"]*)"/g)].map(m => ({mime: m[1]}));
      const expected = expectedRaw === 'nil' ? null : expectedText;
      expect({mimes: mimeList, line: attachmentPreviewLine(mimes)}).toEqual({
        mimes: mimeList,
        line: expected,
      });
    }
  });

  // 개수 문구가 승인 푸시의 본문이 되면 알림 확장이 승인·거절 버튼을 되돌려 놓는다(ADR-0204 D7: 무엇인지
  // 모르는 것을 잠금 화면에서 승인하게 두지 않는다). 컴파일해 돌리는 `sim-check` 는 macOS 에서만 도므로
  // (PR CI 의 폰 jest 는 리눅스다) 가드의 **글자 모양**을 여기서도 못 박는다: 약해지면 CI 가 빨개진다.
  describe('승인 알림은 개수 문구로 본문이 채워지지 않는다 (D7)', () => {
    const announces = SWIFT.match(
      /static func announces\(_ envelope: MomoPushEnvelope\) -> Bool \{([\s\S]*?)\n    \}/,
    );
    const displayBody = SWIFT.match(
      /private static func displayBody\(of message: Message, for envelope: MomoPushEnvelope\) -> String\? \{([\s\S]*?)\n    \}/,
    );

    it('허락하는 이유는 dm·mention 둘뿐이고 승인 카테고리는 이유와 무관하게 막힌다', () => {
      if (!announces) throw new Error('no announces in the Swift source');
      const expression = announces[1].replace(/\s+/g, ' ').trim();
      const reasons = [...expression.matchAll(/envelope\.reason == "([a-z_]+)"/g)].map(m => m[1]).sort();
      expect(reasons).toEqual(['dm', 'mention']);
      // 이유 조건과 카테고리 조건은 AND 다: OR 로 풀리면 승인 카테고리가 다시 열린다.
      expect(expression).toMatch(/\)\s*&&\s*!envelope\.category\.carriesApprovalID$/);
    });

    it('본문을 고르는 길이 이 가드와 지워진 메시지 판정을 개수 문구보다 먼저 거친다', () => {
      if (!displayBody) throw new Error('no displayBody in the Swift source');
      const body = displayBody[1];
      const guardAt = body.indexOf('PushAttachmentCopy.announces(envelope)');
      const lineAt = body.indexOf('PushAttachmentCopy.line(');
      expect(guardAt).toBeGreaterThan(-1);
      expect(lineAt).toBeGreaterThan(guardAt);
      expect(body).toContain('message.state?.value != "deleted"');
      // 글이 있으면 글이 이긴다(승인도 예전 그대로): 그 갈래가 가드보다 앞선다.
      expect(body.indexOf('if !text.isEmpty { return text }')).toBeGreaterThan(-1);
      expect(body.indexOf('if !text.isEmpty { return text }')).toBeLessThan(guardAt);
    });
  });

  it('사진 규칙(SVG 는 파일)을 Swift 도 글자로 갖고 있다', () => {
    const body = SWIFT.match(/static func isPhoto\(mime: String\) -> Bool \{([\s\S]*?)\n    \}/);
    if (!body) throw new Error('no isPhoto in the Swift source');
    expect(body[1]).toContain('hasPrefix("image/")');
    expect(body[1]).toContain('!lowered.hasPrefix("image/svg")');
  });
});
