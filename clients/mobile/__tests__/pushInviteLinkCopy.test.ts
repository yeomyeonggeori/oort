import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  INVITE_LINK_KIND,
  inviteLinkNotificationText,
} from '@momo/core/features/notifications/model';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';

// =============================================================================
// #5025 - 도우미 초대 링크 메시지(ADR-0201 증보 v3 B4-2, #4965)의 푸시 문장.
//
// 그 메시지의 본문은 「문장 + 링크」다. 푸시 본문은 서버가 쓰지 않고 알림 확장(Swift)이 REST 로 메시지를 읽어
// 짓는데(ADR-0204), 예전 `displayBody` 는 본문 전체를 썼다: 도우미가 DM 으로 링크를 올리면 잠금 화면에 링크가
// 떴다. 고친 Swift 는 표지(`props.kind`)가 있으면 본문을 읽지 않고 `props.preview` 한 문장을 말한다 - 코어의
// `inviteLinkNotificationText`(데스크탑·웹 배너)와 **같은 규칙·같은 문장**이어야 한다.
//
// 두 언어가 따로 컴파일되니 이 시험이 둘을 맞댄다. 컴파일해 돌리는 Swift 쪽 동작은 `sim-check`(맥에서만
// 도는 `pushActionContract.test.ts` 와 스택 검증)가 증명하고, PR CI 의 폰 jest 는 리눅스라 그것을 건너뛴다.
// 그래서 **분기가 있다는 것과 그 순서**를 글자로 못 박는 것은 여기 몫이다: 분기가 빠지거나 본문 읽기 뒤로
// 밀리면 CI 가 빨개진다.
//
//   1. Swift 의 표지 낱말·고정 문장이 코어 상수·문구 사전의 ko 값과 같다.
//   2. Swift 가 세는 링크 모양 조각이 코어가 링크로 보는 조각이다.
//   3. 본문을 고르는 길은 표지 갈래를 글보다 앞에 두고, 본문을 읽는 곳은 그 길 하나뿐이다.
// =============================================================================

const APP_ROOT = join(__dirname, '..');
const SWIFT = readFileSync(join(APP_ROOT, 'ios/MomoPushKit/PushNotification.swift'), 'utf8');

/** `public enum <name> { … }` 의 안쪽. 닫는 중괄호가 0칸 들여쓰기인 첫 줄까지다. */
function swiftEnum(name: string): string {
  const match = SWIFT.match(new RegExp(`public enum ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`no enum ${name} in the Swift source`);
  return match[1];
}

function swiftConstant(source: string, name: string): string {
  const match = source.match(new RegExp(`static let ${name} = "([^"]*)"`));
  if (!match) throw new Error(`no constant ${name} in PushInviteLinkCopy`);
  return match[1];
}

const COPY = swiftEnum('PushInviteLinkCopy');

/** `displayBody` 의 안쪽: 닫는 중괄호가 4칸 들여쓰기인 첫 줄까지(안쪽 `if` 의 중괄호는 8칸이라 걸리지 않는다). */
function displayBodyInside(): string {
  const match = SWIFT.match(
    /private static func displayBody\(of message: Message, for envelope: MomoPushEnvelope\) -> String\? \{([\s\S]*?)\n {4}\}/,
  );
  if (!match) throw new Error('no displayBody in the Swift source');
  return match[1];
}

describe('Swift 알림 확장의 도우미 초대 링크 문장은 코어·문구 사전과 같은 말이다 (#5025)', () => {
  it('표지 낱말이 코어가 읽는 낱말과 같다', () => {
    expect(swiftConstant(COPY, 'kind')).toBe(INVITE_LINK_KIND);
    expect(INVITE_LINK_KIND).toBe('team_ai_invite_link');
  });

  it('고정 문장이 문구 사전(notifications.inviteLink.fallback)의 ko 값과 같다', () => {
    const dictionary = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog}).formatMessage(
      'notifications.inviteLink.fallback',
    );
    expect(dictionary.trim()).not.toBe('');
    expect(swiftConstant(COPY, 'fallback')).toBe(dictionary);
  });

  it('Swift 가 세는 링크 모양 조각은 코어도 링크로 본다: 그 조각이 preview 에 들면 고정 문장으로 물러난다', () => {
    const carries = COPY.match(/static func carriesLink\(_ text: String\) -> Bool \{([\s\S]*?)\n {4}\}/);
    if (!carries) throw new Error('no carriesLink in PushInviteLinkCopy');
    // 대소문자는 소문자로 접은 뒤 센다(`join?code=` 의 대문자 철자도 링크다).
    expect(carries[1]).toContain('text.lowercased()');
    const needles = [...carries[1].matchAll(/contains\("([^"]*)"\)/g)].map(m => m[1]);
    // 조각이 줄었다면 누군가 걸음쇠를 약하게 한 것이다.
    expect(needles).toEqual(['join?code=', 'join%3fcode%3d', '://']);
    for (const needle of needles) {
      expect(
        inviteLinkNotificationText({kind: INVITE_LINK_KIND, preview: `앞 ${needle} 뒤`}, () => 'FIXED'),
      ).toBe('FIXED');
    }
  });

  describe('본문을 고르는 길 (displayBody)', () => {
    it('표지 갈래가 글(본문)을 읽는 줄보다 앞에 있고 문장만 돌려준다', () => {
      const body = displayBodyInside();
      const branchAt = body.indexOf('message.props?.kind == PushInviteLinkCopy.kind');
      const sentenceAt = body.indexOf('return PushInviteLinkCopy.sentence(preview: message.props?.preview)');
      const textAt = body.indexOf('let text = message.body');
      expect(branchAt).toBeGreaterThan(-1);
      expect(sentenceAt).toBeGreaterThan(branchAt);
      expect(textAt).toBeGreaterThan(sentenceAt);
      // 표지 갈래 안에는 본문도 첨부도 없다: 돌려주는 것은 preview 문장뿐이다.
      expect(body.slice(branchAt, textAt)).not.toMatch(/message\.body|PushAttachmentCopy/);
    });

    it('지워진 메시지는 표지 갈래를 타지 않는다: 같은 조건이 지움을 먼저 거른다', () => {
      expect(displayBodyInside()).toMatch(
        /if message\.state\?\.value != "deleted", message\.props\?\.kind == PushInviteLinkCopy\.kind \{/,
      );
    });

    it('메시지 본문을 읽는 곳은 이 길 하나뿐이다 — 다른 길이 본문을 알림에 올리면 표지가 우회된다', () => {
      expect(SWIFT.match(/message\.body/g)).toHaveLength(1);
      expect(displayBodyInside()).toContain('message.body');
    });
  });
});
