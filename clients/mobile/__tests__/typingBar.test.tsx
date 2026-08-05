import {cleanup, render, screen} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {TypingBar} from '../src/features/conversation/TypingBar';

// =============================================================================
// 「작성 중」 줄 — 이 배치가 가장 무서워하는 회귀는 **낱말이 섞이는 것**이다.
//
// 패킷: *"「작성 중」=사람 typing · 「작업 중」=에이전트 열린 턴. 혼용은 이 배치
// 최악의 회귀."* 서버는 그 경계를 403으로 막는다(에이전트는 typing을 못 낸다).
// 화면에서 경계가 무너지는 길은 하나뿐이다 — **화면이 자기 문장을 짓는 것.**
//
// 그래서 이 파일이 못박는 것은 문구가 아니라 **문구를 짓지 않는다는 사실**이다.
// 이 컴포넌트는 받은 문장을 그대로 뱉고 한 낱말도 더하지 않는다. 그러면 폰이
// 「작업 중」이라고 말할 방법 자체가 없어진다 — 코어가 지은 문장에 그 말이
// 없는 한.
//
// 문장을 짓는 규칙(몇 명부터 접는가, 조사를 어떻게 고르는가)의 단정은 코어가
// 랜딩할 때 코어 옆에 선다. 이 레포는 이미 그 갈림을 한 번 겪었다:
// `features/agents/turnCopy.ts` 머리말 — *"was a second copy of the exact
// strings 작업 중 and 승인 대기 on the phone."* 같은 결함을 「작성 중」으로 한
// 번 더 만들지 않는다.
// =============================================================================

afterEach(cleanup);

describe('작성 중 한 줄', () => {
  it('받은 문장을 그대로 말하고, 한 낱말도 더하지 않는다', () => {
    // 이 단정이 이 파일의 전부다. 「…님이」를 여기서 붙이거나 말줄임을 여기서
    // 더하면, 그 순간 폰은 문구의 두 번째 정본이 된다.
    render(<TypingBar sentence="곽성재님이 작성 중…" />);
    const line = screen.getByTestId('composer-typing');
    expect(line.props.children).toBe('곽성재님이 작성 중…');
  });

  it('신호가 없으면 자리도 차지하지 않는다', () => {
    render(<TypingBar sentence={null} />);
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });

  it('빈 문자열도 신호 없음과 같이 다룬다', () => {
    // 코어가 「아무도 안 치고 있다」를 빈 문자열로 표현하든 null 로 표현하든,
    // 화면에 빈 줄 하나가 남는 일은 없어야 한다.
    render(<TypingBar sentence="   " />);
    expect(screen.queryByTestId('composer-typing')).toBeNull();
  });

  it('한 줄이고, 읽던 문장을 자르지 않는다', () => {
    render(<TypingBar sentence="곽성재님, 김민수님이 작성 중…" />);
    const line = screen.getByTestId('composer-typing');
    expect(line.props.numberOfLines).toBe(1);
    // 「누가 치고 있다」가 남의 말을 자를 만큼 중요한 적은 없다.
    expect(line.props.accessibilityLiveRegion).toBe('polite');
  });

  it('이 파일 안에 사람에게 보일 문장이 **박혀 있지 않다**', () => {
    // 위의 단정들은 "지금 안 짓는다"를 증명한다. 이것은 "짓기 시작하면 걸린다"를
    // 맡는다 — 나중에 누군가 편의로 기본 문구 하나를 넣는 순간 빨개진다.
    // `projectShape.test.ts` 가 이 레포에서 쓰는 것과 같은 종류의 단정이다.
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/features/conversation/TypingBar.tsx'),
      'utf8',
    );
    // 주석은 이 경계를 **설명해야** 하므로 두 낱말이 다 들어 있다. 검사 대상은
    // 코드뿐이다.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('작성 중');
    expect(code).not.toContain('작업 중');
  });
});
