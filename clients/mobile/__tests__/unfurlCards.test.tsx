import type {MessageUnfurl} from '@momo/core/features/timeline/unfurl';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {Dimensions, Linking, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {LINK_CARD} from '../src/features/conversation/linkCardDesign';
import {
  linkPreviewPreference,
  setLinkPreviewPreference,
} from '../src/features/conversation/linkPreviewPreference';
import {
  createRowViewability,
  RowViewabilityContext,
} from '../src/features/conversation/rowViewability';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';
import {UnfurlCards} from '../src/features/conversation/UnfurlCards';

// =============================================================================
// 폰 링크 카드 (#4883) — 코어 표시 모델(`unfurlCardModel`·`visibleUnfurls`)이 정한 모양을 **그리기만** 한다.
//
// 이 파일이 재는 것은 값이다: 어떤 모양의 카드가 서는가(`unfurl-hero` 가 있는가, 칸이 56 인가, 재생 표시가 어디 서는가),
// 눌렀을 때 무엇이 열리는가, 낭독 이름이 무엇인가. 판정의 표(어떤 그림이 「작은」 그림인가)는 코어 `unfurl.test.ts` 가 잰다 —
// 여기서는 **화면이 그 판정을 다시 하지 않는가**를 두 길로 잰다: ① 설정이 「크게」여도 작은 그림은 작은 카드로 선다(모델이
// 가른 결과를 화면이 뒤집으면 붉어진다), ② 카드 소스가 그림 크기·문턱·상한 상수를 읽지 않는다(소스를 훑는다).
//
// 한 줄 요약의 틀: 모든 카드는 한 `Pressable`(`unfurl-card`)이고, 낭독 이름은 「링크 미리보기: 제목, 도메인」이다.
// =============================================================================

const ROW = 'm-7';
const BASE_WINDOW = Dimensions.get('window');
const IMAGE_PATH = '/v1/workspaces/ws/unfurls/u1/image';
const ICON_PATH = '/v1/workspaces/ws/unfurls/u1/icon';
const DATA_URL = 'data:image/png;base64,AAAA';
const mmkv = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

function setFontScale(fontScale: number) {
  const window = {...BASE_WINDOW, fontScale};
  Dimensions.set({window, screen: window});
}

function unfurl(over: Partial<MessageUnfurl> = {}): MessageUnfurl {
  return {
    id: 'u1',
    messageId: 'm1',
    url: 'https://example.com/post',
    status: 'ok',
    title: '배포 후기',
    description: '세 번째 시도에서 드디어 성공한 이야기',
    domain: 'example.com',
    imageUrl: IMAGE_PATH,
    imageWidth: 1200,
    imageHeight: 630,
    ...over,
  };
}

let requests: string[] = [];
let failing: Set<string> = new Set();

function installLoader() {
  requests = [];
  failing = new Set();
  resetUnfurlImagesForTest(async imageUrl => {
    requests.push(imageUrl);
    if (failing.has(imageUrl)) throw new Error('proxy refused');
    return DATA_URL;
  });
}

// 그림·아이콘·재생 표시는 낭독에서 빠지는 장식이라(`accessibilityElementsHidden`) 기본 질의에는 보이지 않는다.
const HIDDEN = {includeHiddenElements: true} as const;
const byId = (testID: string) => screen.getByTestId(testID, HIDDEN);
const maybeId = (testID: string) => screen.queryByTestId(testID, HIDDEN);

function flat(testID: string): Record<string, any> {
  return (StyleSheet.flatten(byId(testID).props.style) ?? {}) as Record<string, any>;
}

async function settled() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mmkv.clear();
  setFontScale(1);
  installLoader();
});
afterEach(() => {
  cleanup();
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
  resetUnfurlImagesForTest();
});

describe('세 모양 — 코어 모델이 가른 대로 그린다', () => {
  it('큰 카드: 그림이 위(1.91:1), 글이 아래, 폭은 300까지다', async () => {
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} preference="rich" />);
    await waitFor(() => expect(byId('unfurl-image')).toBeTruthy());
    // 모양: 그림 틀이 있고, 왼쪽 그림 칸은 없다.
    expect(screen.getByTestId('unfurl-hero')).toBeTruthy();
    expect(screen.queryByTestId('unfurl-thumb')).toBeNull();
    expect(flat('unfurl-hero').aspectRatio).toBe(LINK_CARD.heroRatio);
    expect(flat('unfurl-hero').aspectRatio).toBeCloseTo(1.91, 2);
    expect(flat('unfurl-group').maxWidth).toBe(300);
    // 그림은 틀을 채우도록 자른다.
    expect(byId('unfurl-image').props.resizeMode).toBe('cover');
    expect(byId('unfurl-image').props.source).toEqual({uri: DATA_URL});
    // 글: 제목(진하게) · 설명 · 아이콘 + 실제 도메인. 줄 수 상한은 제목 둘·설명 둘이다.
    expect(screen.getByTestId('unfurl-title')).toHaveTextContent('배포 후기');
    expect(screen.getByTestId('unfurl-title').props.numberOfLines).toBe(2);
    expect(flat('unfurl-title').fontWeight).toBe('600');
    expect(screen.getByTestId('unfurl-description').props.numberOfLines).toBe(2);
    expect(screen.getByTestId('unfurl-domain')).toHaveTextContent('example.com');
  });

  it('설정이 「크게」여도 작은 그림은 작은 카드로 선다 — 화면이 모델의 판정을 뒤집지 않는다', async () => {
    // 가로 300 미만 → 코어가 `small` 로 가르고, 큰 카드는 1.91:1 틀을 채울 수 있는 그림에만 선다.
    render(
      <UnfurlCards
        unfurls={[unfurl({imageWidth: 120, imageHeight: 120})]}
        rowKey={ROW}
        preference="rich"
      />,
    );
    await waitFor(() => expect(byId('unfurl-image')).toBeTruthy());
    expect(screen.queryByTestId('unfurl-hero')).toBeNull();
    expect(screen.getByTestId('unfurl-thumb')).toBeTruthy();
    // 작은 그림은 자르지 않고 칸에 통째로 넣는다.
    expect(byId('unfurl-image').props.resizeMode).toBe('contain');
  });

  it('작은 카드: 모든 그림이 왼쪽 56pt 칸이고(보통 그림은 자른다), 글은 한 줄씩이다', async () => {
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} preference="compact" />);
    await waitFor(() => expect(byId('unfurl-image')).toBeTruthy());
    expect(screen.queryByTestId('unfurl-hero')).toBeNull();
    const thumb = flat('unfurl-thumb');
    expect([thumb.width, thumb.height]).toEqual([56, 56]);
    expect(byId('unfurl-image').props.resizeMode).toBe('cover');
    expect(screen.getByTestId('unfurl-title').props.numberOfLines).toBe(1);
    expect(screen.getByTestId('unfurl-description').props.numberOfLines).toBe(1);
  });

  it('그림이 없는 카드: 같은 56pt 칸에 지구가 서고 오류 문구는 없다(사이트 아이콘이 있으면 그것)', async () => {
    const noPicture = unfurl({imageUrl: undefined, imageWidth: undefined, imageHeight: undefined});
    const {rerender} = render(
      <UnfurlCards unfurls={[noPicture]} rowKey={ROW} preference="rich" />,
    );
    // 「크게」를 골라도 그림이 없으면 작은 행이다(큰 틀이 비지 않는다).
    expect(screen.queryByTestId('unfurl-hero')).toBeNull();
    expect(screen.getByTestId('unfurl-tile')).toBeTruthy();
    expect(byId('unfurl-tile-globe')).toBeTruthy();
    expect(byId('unfurl-globe')).toBeTruthy();
    expect(screen.queryByText(/실패|오류|불러오지/)).toBeNull();

    rerender(
      <UnfurlCards
        unfurls={[{...noPicture, iconUrl: ICON_PATH}]}
        rowKey={ROW}
        preference="rich"
      />,
    );
    await waitFor(() => expect(byId('unfurl-tile-icon')).toBeTruthy());
    expect(maybeId('unfurl-tile-globe')).toBeNull();
  });

  it('그림을 못 받으면 깨진 그림이 아니라 같은 타일이다 — 큰 카드는 작은 카드로 내려온다', async () => {
    failing.add(IMAGE_PATH);
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} preference="rich" />);
    await waitFor(() => expect(screen.getByTestId('unfurl-tile')).toBeTruthy());
    expect(screen.queryByTestId('unfurl-hero')).toBeNull();
    expect(maybeId('unfurl-image')).toBeNull();
    expect(screen.getByTestId('unfurl-title')).toHaveTextContent('배포 후기');
  });
});

describe('동영상 — 그림 위 재생 표시, 누르면 원래 페이지', () => {
  it('큰 그림 위, 56 칸 위, 그림 없는 타일 자리에 재생 표시가 선다', async () => {
    const video = unfurl({isVideo: true});
    const {rerender} = render(<UnfurlCards unfurls={[video]} rowKey={ROW} preference="rich" />);
    expect(byId('unfurl-play')).toBeTruthy();
    expect(flat('unfurl-play').width).toBe(LINK_CARD.playHero);

    rerender(<UnfurlCards unfurls={[video]} rowKey={ROW} preference="compact" />);
    await settled();
    expect(byId('unfurl-play')).toBeTruthy();
    expect(flat('unfurl-play').width).toBe(LINK_CARD.playThumb);

    const bare = {...video, imageUrl: undefined, imageWidth: undefined, imageHeight: undefined};
    rerender(<UnfurlCards unfurls={[bare]} rowKey={ROW} preference="compact" />);
    expect(screen.getByTestId('unfurl-tile')).toBeTruthy();
    expect(byId('unfurl-play')).toBeTruthy();
    expect(maybeId('unfurl-tile-globe')).toBeNull();
    // 재생 표시는 장식이다 — 낭독에 따로 읽히지 않는다.
    expect(byId('unfurl-play').props.accessibilityElementsHidden).toBe(true);
  });

  it('동영상이 아니면 재생 표시가 없다', async () => {
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} preference="rich" />);
    await settled();
    expect(maybeId('unfurl-play')).toBeNull();
  });
});

describe('링크 3개 상한과 조용한 부재', () => {
  const four = ['a', 'b', 'c', 'd'].map(name =>
    unfurl({
      id: `u-${name}`,
      url: `https://example.com/${name}`,
      title: `제목 ${name}`,
      imageUrl: undefined,
      imageWidth: undefined,
      imageHeight: undefined,
    }),
  );

  it('네 링크가 와도 앞의 서로 다른 셋만 카드다', () => {
    render(<UnfurlCards unfurls={four} rowKey={ROW} preference="compact" />);
    expect(screen.getAllByTestId('unfurl-card')).toHaveLength(3);
    expect(screen.queryByText('제목 d')).toBeNull();
  });

  it('같은 페이지를 다르게 쓴 링크(#조각)는 한 링크로 센다', () => {
    const same = [
      unfurl({id: 'x1', url: 'https://example.com/p', imageUrl: undefined}),
      unfurl({id: 'x2', url: 'https://example.com/p#top', imageUrl: undefined}),
    ];
    render(<UnfurlCards unfurls={same} rowKey={ROW} preference="compact" />);
    expect(screen.getAllByTestId('unfurl-card')).toHaveLength(1);
  });

  it('불러오는 중은 한 칸짜리 자리(낭독 「링크 미리보기를 불러오는 중」), 실패·차단·빈 것은 아무것도 없다', () => {
    render(
      <UnfurlCards
        unfurls={[
          unfurl({id: 'p1', status: 'pending', url: 'https://example.com/1'}),
          unfurl({id: 'f1', status: 'failed', url: 'https://example.com/2'}),
          unfurl({id: 'b1', status: 'blocked', url: 'https://example.com/3'}),
          unfurl({
            id: 'e1',
            url: 'https://example.com/4',
            title: undefined,
            imageUrl: undefined,
            description: undefined,
          }),
        ]}
        rowKey={ROW}
        preference="compact"
      />,
    );
    expect(screen.queryAllByTestId('unfurl-card')).toHaveLength(0);
    expect(screen.getAllByTestId('unfurl-pending')).toHaveLength(1);
    expect(screen.getByTestId('unfurl-pending').props.accessibilityLabel).toBe(
      '링크 미리보기를 불러오는 중',
    );
  });
});

describe('낭독 이름과 누르기', () => {
  it('이름은 「링크 미리보기: 제목, 도메인」이고 동영상이면 「동영상」이 이어진다', () => {
    const {rerender} = render(
      <UnfurlCards unfurls={[unfurl()]} rowKey={ROW} preference="compact" />,
    );
    const card = screen.getByTestId('unfurl-card');
    expect(card.props.accessibilityLabel).toBe('링크 미리보기: 배포 후기, example.com');
    expect(card.props.accessibilityRole).toBe('link');
    // 장식(그림·아이콘)은 낭독에서 빠진다.
    expect(byId('unfurl-globe').props.accessibilityElementsHidden).toBe(true);

    rerender(<UnfurlCards unfurls={[unfurl({isVideo: true})]} rowKey={ROW} preference="compact" />);
    expect(screen.getByTestId('unfurl-card').props.accessibilityLabel).toBe(
      '링크 미리보기: 배포 후기, example.com, 동영상',
    );
  });

  it('제목이 없으면 사이트 이름, 그것도 없으면 도메인이 제목 자리에 서고 주소 줄은 늘 실제 도메인이다', () => {
    const {rerender} = render(
      <UnfurlCards
        unfurls={[unfurl({title: undefined, siteName: '사이트 이름', domain: 'real.example'})]}
        rowKey={ROW}
        preference="compact"
      />,
    );
    expect(screen.getByTestId('unfurl-title')).toHaveTextContent('사이트 이름');
    expect(screen.getByTestId('unfurl-domain')).toHaveTextContent('real.example');
    rerender(
      <UnfurlCards
        unfurls={[unfurl({title: undefined, domain: 'real.example'})]}
        rowKey={ROW}
        preference="compact"
      />,
    );
    expect(screen.getByTestId('unfurl-title')).toHaveTextContent('real.example');
  });

  it('누르면 바깥 브라우저로 그 링크가 열린다, 길게 누르면 링크 시트를 부른다', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const onLongPressCard = jest.fn();
    render(
      <UnfurlCards
        unfurls={[unfurl()]}
        rowKey={ROW}
        preference="compact"
        onLongPressCard={onLongPressCard}
      />,
    );
    fireEvent.press(screen.getByTestId('unfurl-card'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com/post');
    expect(onLongPressCard).not.toHaveBeenCalled();

    fireEvent(screen.getByTestId('unfurl-card'), 'longPress');
    expect(onLongPressCard).toHaveBeenCalledWith({
      id: 'u1',
      url: 'https://example.com/post',
      title: '배포 후기',
      domain: 'example.com',
    });
    // 길게 누른 손가락이 링크를 따로 열지는 않는다.
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });
});

describe('이 기기의 설정 — 작게(기본) · 크게 · 끄기', () => {
  it('저장된 값이 없으면 작게다(코어의 기본 한 곳)', async () => {
    expect(linkPreviewPreference()).toBe('compact');
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} />);
    await waitFor(() => expect(byId('unfurl-image')).toBeTruthy());
    expect(screen.queryByTestId('unfurl-hero')).toBeNull();
    expect(screen.getByTestId('unfurl-thumb')).toBeTruthy();
  });

  it('고르면 열려 있는 카드가 바로 따라간다: 크게 → 작게 → 끄기(끄면 아무것도 그리지 않는다)', async () => {
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} />);
    await settled();
    act(() => setLinkPreviewPreference('rich'));
    await waitFor(() => expect(screen.getByTestId('unfurl-hero')).toBeTruthy());
    act(() => setLinkPreviewPreference('compact'));
    await waitFor(() => expect(screen.getByTestId('unfurl-thumb')).toBeTruthy());
    act(() => setLinkPreviewPreference('off'));
    expect(screen.queryByTestId('unfurl-group')).toBeNull();
    expect(screen.queryByTestId('unfurl-card')).toBeNull();
    // 끄면 불러오는 중 자리도 없다.
    act(() => setLinkPreviewPreference('compact'));
    await settled();
  });

  it('끈 채로는 그림을 받지 않는다 — 요청 자체가 없다', async () => {
    setLinkPreviewPreference('off');
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} />);
    await settled();
    expect(requests).toEqual([]);
  });
});

describe('그림과 아이콘은 프록시 경로로만, 아이콘은 줄이 보인 뒤에', () => {
  const withIcon = unfurl({iconUrl: ICON_PATH});

  it('그림은 카드가 서면 바로 받고, 아이콘은 줄이 한 번 보이기 전에는 요청하지 않는다', async () => {
    const viewability = createRowViewability();
    render(
      <RowViewabilityContext.Provider value={viewability}>
        <UnfurlCards unfurls={[withIcon]} rowKey={ROW} preference="compact" />
      </RowViewabilityContext.Provider>,
    );
    await settled();
    expect(requests).toEqual([IMAGE_PATH]);

    // 다른 줄이 보이는 것은 이 줄의 아이콘을 켜지 않는다.
    act(() => viewability.update(['m-8']));
    await settled();
    expect(requests).toEqual([IMAGE_PATH]);

    act(() => viewability.update([ROW]));
    await waitFor(() => expect(requests).toEqual([IMAGE_PATH, ICON_PATH]));
    // 한 번 보였으면 줄이 화면을 떠나도 계속 보인 것으로 친다(다시 묻지 않는다).
    act(() => viewability.update([]));
    await settled();
    expect(requests).toEqual([IMAGE_PATH, ICON_PATH]);
  });

  it('보이는 줄을 아는 목록이 없는 표면(하네스·스레드)에서는 아이콘이 마운트 때 켜진다', async () => {
    render(<UnfurlCards unfurls={[withIcon]} rowKey={ROW} preference="compact" />);
    await waitFor(() => expect(requests).toContain(ICON_PATH));
  });

  it('아이콘이 오면 주소 줄의 지구가 사이트 아이콘으로 바뀌고, 못 받으면 지구로 남는다(오류 문구 없음)', async () => {
    const {unmount} = render(<UnfurlCards unfurls={[withIcon]} rowKey={ROW} preference="compact" />);
    await waitFor(() => expect(byId('unfurl-icon')).toBeTruthy());
    expect(maybeId('unfurl-globe')).toBeNull();
    unmount();

    resetUnfurlImagesForTest(async imageUrl => {
      if (imageUrl === ICON_PATH) throw new Error('proxy refused');
      return DATA_URL;
    });
    render(<UnfurlCards unfurls={[withIcon]} rowKey={ROW} preference="compact" />);
    await settled();
    await waitFor(() => expect(byId('unfurl-image')).toBeTruthy());
    expect(byId('unfurl-globe')).toBeTruthy();
    expect(screen.queryByText(/실패|오류/)).toBeNull();
  });
});

describe('큰 글씨 — 글이 잘리지 않고 카드가 자란다', () => {
  it('글자 배율 1.5부터 제목·설명·주소의 줄 수 상한이 없다', async () => {
    setFontScale(2);
    render(<UnfurlCards unfurls={[unfurl()]} rowKey={ROW} preference="rich" />);
    await settled();
    expect(screen.getByTestId('unfurl-title').props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('unfurl-description').props.numberOfLines).toBeUndefined();
    expect(screen.getByTestId('unfurl-domain').props.numberOfLines).toBeUndefined();
    // 카드 높이는 고정이 아니다: 그림 틀만 비율이고 나머지는 내용이 정한다.
    expect(flat('unfurl-card').height).toBeUndefined();
    // 읽는 글자라 배율 상한도 없다.
    expect(screen.getByTestId('unfurl-title').props.maxFontSizeMultiplier).toBeUndefined();
  });
});

describe('치수 — 웹 토큰과 짝이거나 이유 있는 분기다', () => {
  // 폰 값 중 웹에 짝이 있는 것은 같은 값이어야 하고, 다른 것은 **이유와 함께 열거**한다(`docs/design-system/README.md` §6
  // 「폰에 값을 더할 때」). 웹 토큰이 움직이면 여기가 붉어져 폰의 값을 다시 보게 한다.
  const css = fs.readFileSync(path.join(__dirname, '../../web/src/design/tokens.css'), 'utf8');
  const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();

  it('큰 카드 그림의 비율은 웹 --aspect-og(OG 표준 1.91:1)와 같은 값이다', () => {
    const [width, height] = (token('aspect-og') ?? '').split('/').map(part => Number(part.trim()));
    expect(width / height).toBe(LINK_CARD.heroRatio);
  });

  it('작은 카드의 칸 56은 이슈가 정한 분기다 — 웹은 64(보통 그림 104)이고, 웹 값이 움직이면 이 분기를 다시 본다', () => {
    expect(token('spacing-unfurl-tile')).toBe('64px');
    expect(token('spacing-unfurl-thumb')).toBe('104px');
    expect(LINK_CARD.thumb).toBe(56);
    expect(LINK_CARD.maxWidth).toBe(300);
  });
});

describe('소스 — 화면은 모양 판정을 다시 하지 않는다', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '../src/features/conversation/UnfurlCards.tsx'),
    'utf8',
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');

  it('그림 크기·문턱·상한 상수와 서버 크기 필드를 읽는 코드가 0줄이다', () => {
    const banned = [
      /\bimageWidth\b/,
      /\bimageHeight\b/,
      /UNFURL_WIDE_PICTURE_MIN_(?:WIDTH|RATIO)/,
      /UNFURL_MAX_CARDS/,
      /UNFURL_IMAGE_SIDE_MAX/,
      /\.slice\(\s*0\s*,\s*3\s*\)/,
    ];
    expect(banned.filter(pattern => pattern.test(code)).map(String)).toEqual([]);
  });

  it('모델을 부르는 두 함수가 실제로 쓰인다(위 단정이 빈 파일을 훑고 통과하지 않는다)', () => {
    expect(code).toMatch(/unfurlCardModel\(/);
    expect(code).toMatch(/visibleUnfurls\(/);
  });
});
