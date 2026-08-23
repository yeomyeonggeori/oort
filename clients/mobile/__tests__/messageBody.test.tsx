import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react-native';
import React from 'react';
import {Linking, StyleSheet} from 'react-native';

import {FixedScheme, type ColorScheme} from '../src/design/theme';
import {
  darkPalette,
  lightPalette,
  type Palette,
} from '../src/design/tokens';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {
  MessageBody,
  splitItalicRuns,
} from '../src/features/conversation/MessageBody';

// =============================================================================
// 폰 본문 렌더 — BL-1·BL-3 (goal U4-a / #1048).
//
// ## 고치는 결함을 정확히 적어 둔다
//
// U1 감사가 실기기 캡처로 확증한 **지배적 실패 모드**는 「마크다운이 안 그려진다」가
// 아니라 이것이다: 분기 조건이 `body.includes('```')` 였으므로 **답변에 코드 펜스가
// 하나라도 있으면 답 전체가 하나의 모노스페이스 상자**로 들어갔다. 기술 답변에는
// 펜스가 거의 항상 있으므로, 사실상 에이전트의 모든 답이 로그 덤프처럼 왔다.
// 감사 문서가 `md-01` 에서 실측한 것: `#` 가 글자로 남고, 별표가 글자로 남고,
// 한국어 산문이 12px Menlo 로 조판되고, 셸 명령이 가로로 잘렸다.
//
// 그래서 이 파일의 첫 단정은 「마크다운이 그려진다」가 아니라 **「산문이 코드가
// 되지 않는다」** 다. 그것이 사람이 실제로 겪던 것이다.
//
// ## 파서는 검사하지 않는다
//
// `parseMarkdown` 은 코어의 것이고 자기 테스트를 가지고 있다. 여기서 묻는 것은
// **그 트리가 폰에서 어떤 구조가 되는가**뿐이다 — 문법 표를 여기서 다시 만들면
// 그것이 곧 두 번째 정본이 된다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
  member({
    id: 'cccccccc-1111-4111-8111-cccccccccccc',
    displayName: '떠난 멤버',
    handle: 'gone',
    status: 'deleted',
  }),
]);

const SCHEMES: ReadonlyArray<readonly [ColorScheme, Palette]> = [
  ['dark', darkPalette],
  ['light', lightPalette],
];

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '평문',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

/** 감사 캡처 `md-01` 이 담고 있던 모양의 에이전트 답변. */
const AGENT_ANSWER = [
  '**결론**: 실패',
  '',
  '- `outbox_drain_worker` 가 멈췄다',
  '- 재시작이 필요하다',
  '',
  '```sh',
  'grep -c "pool exhausted" /var/log/momo/relay.log',
  '```',
  '',
  '자세한 것은 [배포 문서](https://momo.example/deploy) 참고.',
].join('\n');

afterEach(cleanup);

describe('BL-1 — 산문이 코드 상자가 되지 않는다', () => {
  it('펜스가 하나 있어도 답 전체가 코드로 들어가지 않는다', () => {
    // **이 파일에서 가장 중요한 단정.** 옛 분기(`body.includes('```')`)를 되살리면
    // 코드 블록이 하나가 아니라 「전부」가 되고 여기서 걸린다.
    render(<MessageBody body={AGENT_ANSWER} />);
    expect(screen.getByTestId('message-markdown')).toBeTruthy();
    expect(screen.getAllByTestId('message-code-block')).toHaveLength(1);
    // 산문·목록·링크가 코드 밖에 자기 구조로 서 있다.
    expect(screen.getByTestId('message-list')).toBeTruthy();
    expect(screen.getByTestId('message-link')).toBeTruthy();
  });

  it('마크업 문자가 글자로 남지 않는다', () => {
    // 감사가 `md-01` 에서 실측한 것들: 별표·펜스 마커가 본문에 보였다.
    render(<MessageBody body={AGENT_ANSWER} />);
    expect(screen.queryByText(/\*\*결론\*\*/)).toBeNull();
    expect(screen.queryByText(/```/)).toBeNull();
    // 대신 그 낱말이 굵게 선다.
    expect(screen.getByText('결론')).toBeTruthy();
  });

  it('코드 블록은 코드만 담는다 — 한국어 산문이 그 안에 없다', () => {
    const view = render(<MessageBody body={AGENT_ANSWER} />);
    // 코드 블록 서브트리의 글자만 모은다.
    const inCode = within(screen.getByTestId('message-code-block'));
    expect(inCode.getByText(/pool exhausted/)).toBeTruthy();
    expect(inCode.queryByText(/재시작이 필요하다/)).toBeNull();
    // 그리고 그 문장은 **본문 어딘가에는** 있다 — 사라진 것이 아니라 밖에 있다.
    expect(view.getByText(/재시작이 필요하다/)).toBeTruthy();
  });

  it('L-6 — 코드 블록이 자기 언어를 말한다', () => {
    render(<MessageBody body={AGENT_ANSWER} />);
    expect(screen.getByTestId('message-code-lang').props.children).toBe('sh');
  });

  it('평문은 예전 그대로 한 덩이다 — 타임라인 밀도가 바뀌지 않는다', () => {
    // 이 대화의 대부분이 평문이다. 그 자리에서 모양이 바뀌면 이 배치는 고친 것보다
    // 많은 것을 바꾼 셈이 된다.
    render(<MessageBody body={'그냥 한 줄입니다'} />);
    expect(screen.queryByTestId('message-markdown')).toBeNull();
    expect(screen.getByText('그냥 한 줄입니다')).toBeTruthy();
  });

  it('행이 이 렌더러를 지난다 — 옛 경로가 남아 있지 않다', () => {
    render(
      <MessageRow
        message={message({body: AGENT_ANSWER})}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    expect(screen.getByTestId('message-markdown')).toBeTruthy();
    expect(screen.getAllByTestId('message-code-block')).toHaveLength(1);
  });
});

describe.each(SCHEMES)('%s — 본문 멘션 렌더', (scheme, palette) => {
  it('활성 멤버만 accent로 그리고 미매칭 핸들은 원문으로 둔다', () => {
    const view = render(
      <FixedScheme scheme={scheme}>
        <MessageBody
          body="@intern-kim @missing @gone"
          directory={DIRECTORY}
          selfMemberId={SELF}
        />
      </FixedScheme>,
    );

    const mention = StyleSheet.flatten(
      screen.getByTestId('message-mention').props.style,
    );
    expect(mention.color).toBe(palette.accentText);
    expect(mention.backgroundColor).toBeUndefined();
    expect(view.queryByTestId('message-self-mention')).toBeNull();
    expect(JSON.stringify(view.toJSON())).toContain('@missing');
    expect(JSON.stringify(view.toJSON())).toContain('@gone');
  });

  it('내 멘션은 accentSurface 채움과 추가 굵기를 얻는다', () => {
    render(
      <FixedScheme scheme={scheme}>
        <MessageBody
          body="@Seongjae @intern-kim"
          directory={DIRECTORY}
          selfMemberId={SELF}
        />
      </FixedScheme>,
    );

    const self = screen.getByTestId('message-self-mention');
    const style = StyleSheet.flatten(self.props.style);
    expect(self.props.children).toBe('@Seongjae');
    expect(style.color).toBe(palette.accentText);
    expect(style.backgroundColor).toBe(palette.accentSurface);
    expect(style.fontWeight).toBe('700');
    expect(screen.getByTestId('message-mention')).toBeTruthy();
  });
});

describe('BL-3 — 링크가 눌린다, 그리고 아무것이나 열지 않는다', () => {
  it('허용된 링크는 그 주소를 연다', () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    render(<MessageBody body={'[배포 문서](https://momo.example/deploy)'} />);
    fireEvent.press(screen.getByTestId('message-link'));
    expect(openURL).toHaveBeenCalledWith('https://momo.example/deploy');
    openURL.mockRestore();
  });

  it('비허용 스킴은 **링크가 되지도 않는다**', () => {
    // 코어 `safeHref` 가 파싱 단계에서 거절하므로 누를 것 자체가 없다. 이것이
    // 「눌러도 안 열린다」보다 강한 성질이다 — 열 대상이 화면에 존재하지 않는다.
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    for (const evil of [
      '[탭](javascript:alert(1))',
      '[탭](JaVaScRiPt:alert(1))',
      '[탭](java\tscript:alert(1))',
      '[탭](data:text/html,<script>alert(1)</script>)',
      '[탭](file:///etc/passwd)',
      '[탭](/settings)',
    ]) {
      const view = render(<MessageBody body={evil} />);
      expect(view.queryByTestId('message-link')).toBeNull();
      view.unmount();
    }
    expect(openURL).not.toHaveBeenCalled();
    openURL.mockRestore();
  });

  it('여는 자리가 한 번 더 본다 — 화면의 방어', () => {
    // `Linking.openURL` 은 웹의 `<a href>` 와 달리 기기가 핸들러를 가진 모든
    // 스킴을 연다(tel:·sms:·커스텀 앱 스킴). 파서를 우회한 값이 어떤 경로로든
    // 여기 닿아도 열리면 안 된다.
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    const {openLink} = require('../src/features/conversation/MessageBody');
    openLink('javascript:alert(1)');
    openLink('tel:+8210');
    expect(openURL).not.toHaveBeenCalled();
    openLink('https://momo.example');
    expect(openURL).toHaveBeenCalledTimes(1);
    openURL.mockRestore();
  });

  it('아티팩트 카드의 주소도 같은 문을 지난다', () => {
    // BL-3 의 나머지 절반: 이 줄은 강조색만 링크이고 동작이 없었다.
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockResolvedValue(undefined as never);
    render(
      <MessageRow
        message={message({
          type: 'artifact',
          body: '이 PR 로 롤백했습니다',
          // 코어 `linkArtifact` 가 읽는 **평평한** props. 중첩 객체로 주면 카드가
          // 아예 안 서고, 그러면 아래 단정이 헛돈다.
          props: {
            artifact_kind: 'pr',
            title: 'PR #12',
            url: 'https://github.com/example/repo/pull/12',
          },
        })}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
      />,
    );
    // 카드가 실제로 섰는지부터 — 안 선 화면에서 「링크가 있다」는 헛초록이다.
    expect(screen.getByTestId('artifact-card')).toBeTruthy();
    const link = screen.getByTestId('artifact-link');
    fireEvent.press(link);
    expect(openURL).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/12',
    );
    openURL.mockRestore();
  });
});

describe('기울임은 한글에 획을 그리지 않는다', () => {
  it('라틴 구간에만 기울임이 걸린다', () => {
    // 웹의 `font-synthesis-style: none` 과 같은 **결과**를 다른 기계로 만든다.
    // 한글 폰트에는 이탤릭 페이스가 없고, 없는 것을 기계가 만들어내면 저자가
    // 긋지 않은 획이 화면에 생긴다.
    expect(splitItalicRuns('hello')).toEqual([{text: 'hello', italic: true}]);
    expect(splitItalicRuns('안녕')).toEqual([{text: '안녕', italic: false}]);
    const mixed = splitItalicRuns('deploy 실패');
    expect(mixed).toHaveLength(2);
    expect(mixed[0]).toEqual({text: 'deploy ', italic: true});
    expect(mixed[1]).toEqual({text: '실패', italic: false});
  });

  it('공백이 구간을 잘게 쪼개지 않는다', () => {
    // 쪼개면 RN 이 구간마다 줄바꿈 기회를 주면서 글이 다르게 접힌다.
    expect(splitItalicRuns('a b c')).toEqual([{text: 'a b c', italic: true}]);
  });
});
