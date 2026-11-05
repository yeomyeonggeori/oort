import {
  FIXTURE_EXPRESSIONS,
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import type {Expression} from '@momo/core/features/expressions/types';
import {Directory, File, Paths} from 'expo-file-system';
import React, {useEffect, useMemo} from 'react';

import {ExpressionComposerModal} from '../src/features/expressions/ExpressionComposerPicker';
import {EXPRESSION_TABS} from '../src/features/expressions/expressionViews';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type ExpressionFiles,
} from '../src/features/expressions/store';
import type {ExpressionTransport} from '../src/features/expressions/transport';
import {base64ToBytes} from '../src/deviceKey/base64';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {PHOTO} from './profileSheet';
import {Backdrop} from './sheetKit';

// =============================================================================
// 표현 시트(입력창 보내기 왼쪽 단추가 여는 세 탭: 이모티콘 · 기본 · GIF)의 캡처 표면 (#5330) — 웹의 `?expressions=fixture` 에 해당하는
// 폰의 개발 스위치다. **배송되는 `ExpressionComposerModal` 이 그대로 서고**, 서버 자리만 코어 가짜 서버(`fixtureServer.ts`)다.
//
//   -momoMeasure EXPRESSIONSHEET                세 표현(작은 앵무새 · 정지한 큰 엄지척 · 움직이는 기절) — 기본 탭이 먼저 열린다(앞 판과 같다)
//   -momoMeasure EXPRESSIONSHEET-emoticon       이모티콘 탭이 열린 장면(`-gif`·`-emoji` 도 같다)
//   -momoMeasure EXPRESSIONSHEET-emoticon-empty 보관함이 비었다 — 빈 안내와 「＋ 추가하기」가 탭 줄에 붙었는지 본다(owner 11-05 캡처)
//   -momoMeasure EXPRESSIONSHEET-emoticon-en    같은 장면의 영어
//
// 이름 조각을 `-` 로 이어 쓴다: 탭(`emoticon`·`emoji`·`gif`) · `empty` · `en`. 탭 눌러 옮기기는 Maestro 몫이다(`expression-sheet-tab-<탭>`).
// 그림은 앱 캐시 폴더의 파일로 서서 서버 없이도 그려진다.
// 합성 그림·가상 이름뿐이다(코어 fixture).
// =============================================================================

const PNG = FIXTURE_MEDIA.png.image;
// 코어 fixture 의 그림은 1×1 이라 시뮬레이터에서 그려지지 않았다(글자 자리표시로 남는다). 캡처는 하네스가 이미 가진 합성 그라데이션(64×64, 실제 사진 아님)을
// 모든 그림 답으로 준다. 저장소는 받은 바이트가 목록이 말한 크기를 넘으면 버리므로(`bytes.length > media.bytes`) 목록의 크기 값도 이 그림에 맞춘다.
const GRADIENT = base64ToBytes(PHOTO.replace(/^data:image\/png;base64,/, ''));
const THUMBS_ID = FIXTURE_EXPRESSIONS[2].id;
const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;

/** 엄지척을 정지 그림(PNG)으로 바꿔 내려 준다 — 이모티콘 탭에 작은 것과 큰 것이 함께 서고 GIF 탭에는 움직이는 것만 선다. */
function stillThumbs(
  response: ExpressionFixtureResponse,
  empty: boolean,
): ExpressionFixtureResponse {
  const json = response.json as {items?: Expression[]} | undefined;
  if (!json?.items) return response;
  const sized = (media: Expression['media']): Expression['media'] =>
    media && GRADIENT
      ? {
          small: {...media.small, bytes: GRADIENT.length},
          large: {...media.large, bytes: GRADIENT.length},
          thumb: {...media.thumb, bytes: GRADIENT.length},
        }
      : media;
  return {
    ...response,
    json: {
      ...json,
      items: empty
        ? []
        : json.items.map(item => ({
            ...item,
            media: sized(
              item.id === THUMBS_ID && item.media
                ? {...item.media, small: {...PNG}, large: {...PNG}}
                : item.media,
            ),
          })),
    },
  };
}

function sheetTransport(empty: boolean): ExpressionTransport {
  const server = createExpressionFixtureServer({nowMs: Date.now()});
  return {
    async request(request) {
      const response = server.request(request);
      if (request.method === 'GET' && request.path.split('?')[0] === base)
        return stillThumbs(response, empty);
      // 그림 답은 base64 글자로 오는데, 저장소는 그것을 `atob` 으로 푼다 — 이 엔진에 그 전역이 있는지에 기대지 않고 앱이 쓰는 풀이로 바이트를 준다.
      if (response.status === 200 && response.bodyBase64 !== undefined) {
        const bytes = GRADIENT ?? base64ToBytes(response.bodyBase64);
        if (bytes) return {...response, bytes};
      }
      return response;
    },
  };
}

// 그림은 배송되는 `ExpressionProvider` 와 같은 길로 선다: 앱 캐시 폴더의 실제 파일(`file://`). 타일은 글자 안에 선 `Image` 라 `data:` 주소로는
// 시뮬레이터에서 그려지지 않았다(앞 시도의 캡처). 폴더는 처음 쓸 때 만든다(모듈이 읽힐 때 파일 시스템을 부르지 않는다).
let directory: Directory | undefined;
const FILES: ExpressionFiles = {
  write(key, bytes) {
    directory ??= new Directory(Paths.cache, 'oort-expression-sheet-surface');
    if (!directory.exists)
      directory.create({intermediates: true, idempotent: true});
    const file = new File(directory, key);
    file.write(bytes);
    return file.uri;
  },
  remove(uri) {
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      /* already reclaimed */
    }
  },
};

const controller = (language: 'ko-KR' | 'en-US') => () =>
  createMobileLocaleController({
    port: {
      readPreference: () => language,
      writePreference: () => {},
      readDevice: () => ({languages: [language], timeZone: 'Asia/Seoul'}),
    },
  });
// 공장은 모듈 값이다: 렌더마다 새 공장이면 provider 가 사전을 다시 읽는다.
const koController = controller('ko-KR');
const enController = controller('en-US');

const noop = () => {};

export function ExpressionSheetSurface({
  which,
}: {
  which: string;
}): React.JSX.Element {
  const parts = which.split('-');
  const english = parts.includes('en');
  const empty = parts.includes('empty');
  const initialTab = EXPRESSION_TABS.find(tab => parts.includes(tab));
  const store = useMemo(
    () =>
      createPhoneExpressionStore(
        FIXTURE_WORKSPACE_ID,
        FIXTURE_MEMBER_ID,
        sheetTransport(empty),
        FILES,
      ),
    [empty],
  );
  useEffect(() => {
    store.start();
    void store.refresh(true);
    return () => store.dispose();
  }, [store]);
  return (
    <MobileLocaleProvider createController={english ? enController : koController}>
      <Backdrop>
        <PhoneExpressions.Provider value={store}>
          <ExpressionComposerModal
            onClose={noop}
            onInsert={noop}
            onInsertExpression={noop}
            onSend={noop}
            initialTab={initialTab}
          />
        </PhoneExpressions.Provider>
      </Backdrop>
    </MobileLocaleProvider>
  );
}
