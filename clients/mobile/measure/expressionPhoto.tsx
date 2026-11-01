import {
  FIXTURE_MEMBER_ID,
  FIXTURE_WORKSPACE_ID,
} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import {
  createExpressionFixtureServer,
  type ExpressionFixtureResponse,
} from '@momo/core/features/expressions/fixtureServer';
import type {
  PhotoBranch,
  PhotoCutout,
  PhotoFailureCode,
} from '@momo/core/features/expressions/photo';
import React, {useEffect, useMemo} from 'react';

import {PageSheet} from '../src/design/PageSheet';
import {
  ExpressionPhotoForm,
  type PhotoFormDev,
} from '../src/features/expressions/ExpressionPhotoForm';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {
  createPhoneExpressionStore,
  type ExpressionFiles,
} from '../src/features/expressions/store';
import type {
  ExpressionRequest,
  ExpressionTransport,
} from '../src/features/expressions/transport';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {Backdrop} from './sheetKit';

// =============================================================================
// 폰 「AI와 만들기」 사진 길의 캡처 표면 (#4984) — 웹의 `?expressions=fixture&photoModel=…&photoFailure=…` 에 해당하는
// 폰의 개발 스위치다. **배송되는 `ExpressionPhotoForm` 이 그대로 서고**, 서버 자리만 코어 가짜 서버(`fixtureServer.ts`)다.
//
//   -momoMeasure EXPRESSIONPHOTO-<장면>      (라이트: LIGHT-EXPRESSIONPHOTO-<장면> · 영어: 장면 끝에 `-EN`)
//
// 코어 가짜 서버가 못 만드는 것은 이 파일의 얇은 겉옷이 더한다(코어 파일은 엔진 #4941 과 같게 두었다):
//   · `canManage: false` — 코어 가짜 서버는 늘 운영자다(「일반 멤버」 장면)
//   · `cutout` 세 가지 — 코어 가짜 서버는 배경 지우기에 늘 `erased` 로 답한다
//   · 확인 중 / 만드는 중 — 답을 주지 않고 기다린다(취소하면 거절로 끝난다)
//   · 닫힌 코드 밖의 실패(503·409 quota·403 role·413)와 상태 없는 연결 실패
// 값이 채워진 장면은 `ExpressionPhotoForm` 의 `dev` 자리로 값을 미리 채우고 모델 확인이 끝나면 한 번 보낸다(시스템 사진
// 창은 캡처 흐름이 고를 수 없다). 그림은 코어의 합성 PNG(`FIXTURE_MEDIA`)이고 사람 사진이 아니다. 이름은 가상이다.
//
//   checking              확인 중(스피너 + 한 줄)
//   check-failed          확인 실패 + 「다시 시도」 + 「에이전트에게 부탁하기」
//   check-refused         이 팀에서는 올릴 수 없다는 한 줄(다시 시도 없음)
//   no-model-admin        모델 없음 · 운영자(어디서 연결하는지) + 「가져오기로 등록하기」
//   no-model-member       모델 없음 · 일반 멤버(운영자에게 알려 달라는 한 줄)
//   form                  빈 양식(OpenAI)
//   form-filled           채운 양식 · 동의 안 함
//   form-gemini           캐리커처 + 동의함 · 동의 줄이 「Google Gemini」
//   form-no-consent       동의 없이 「만들기」 → 동의 줄 아래 오류, 요청은 나가지 않는다
//   busy                  만드는 중(스피너 + 최대 2분 + 취소) — 동작 줄이기에서는 스피너가 없다
//   failed-<상황>         refused · failed · timeout · unavailable · changed · busy · quota · role · too-large · offline
//   made-model|erased|unchanged   만든 그림 카드 + 배경에 한 일 한 줄(세 가지)
//   made-caricature       만든 그림 카드, 줄 없음
// =============================================================================

export interface PhotoScene {
  model?: 'none' | 'openai' | 'gemini';
  /** 코어 가짜 서버는 늘 `true` 다. */
  canManage?: boolean;
  /** 코어 가짜 서버의 닫힌 실패 코드(다섯). */
  failure?: PhotoFailureCode;
  /** 모델 확인 요청: `pending` 은 답을 주지 않고, 숫자는 그 상태로, 객체는 그 상태와 닫힌 코드로 답한다. */
  check?: 'pending' | number | {status: number; code: string};
  /** 사진 요청의 답을 이 상태·코드로 바꾼다(닫힌 코드 밖의 실패). `0` 은 상태 없는 연결 실패. */
  answer?: {status: number; code?: string};
  /** 사진 요청이 답을 주지 않고 기다린다. */
  hold?: boolean;
  /** 서버가 배경에 한 일을 바꾼다(코어는 배경 지우기에 늘 `erased`). */
  cutout?: PhotoCutout;
  initial?: PhotoFormDev['initial'];
}

const PHOTO_URI = `data:image/png;base64,${FIXTURE_MEDIA.png.bodyBase64}`;
const FILLED = {
  photo: {
    uri: PHOTO_URI,
    name: 'dance.png',
    mime: 'image/png',
    bytes: 120_000,
    width: 1024,
    height: 768,
  },
  name: 'happy_dance',
  displayName: '신나는 춤',
  tags: '축하, 춤',
};
const SENT = {...FILLED, consent: true, submit: true};
const CARICATURE: PhotoBranch = 'caricature';

export const PHOTO_SCENES: Readonly<Record<string, PhotoScene>> = {
  checking: {check: 'pending'},
  'check-failed': {check: 500},
  'check-refused': {check: {status: 403, code: 'expression_role_required'}},
  'no-model-admin': {model: 'none'},
  'no-model-member': {model: 'none', canManage: false},
  form: {model: 'openai'},
  'form-filled': {model: 'openai', initial: FILLED},
  'form-gemini': {
    model: 'gemini',
    initial: {...FILLED, branch: CARICATURE, consent: true},
  },
  'form-no-consent': {model: 'openai', initial: {...FILLED, submit: true}},
  busy: {model: 'openai', hold: true, initial: SENT},
  'failed-refused': {
    model: 'openai',
    failure: 'image_model_refused',
    initial: SENT,
  },
  'failed-failed': {
    model: 'openai',
    failure: 'image_model_failed',
    initial: SENT,
  },
  'failed-timeout': {
    model: 'openai',
    failure: 'image_model_timeout',
    initial: SENT,
  },
  'failed-unavailable': {
    model: 'openai',
    failure: 'image_model_unavailable',
    initial: SENT,
  },
  'failed-changed': {
    model: 'openai',
    failure: 'image_model_changed',
    initial: SENT,
  },
  'failed-busy': {model: 'openai', answer: {status: 503}, initial: SENT},
  'failed-quota': {
    model: 'openai',
    answer: {status: 409, code: 'expression_quota'},
    initial: SENT,
  },
  'failed-role': {
    model: 'openai',
    answer: {status: 403, code: 'expression_role_required'},
    initial: SENT,
  },
  'failed-too-large': {
    model: 'openai',
    answer: {status: 413, code: 'expression_media_invalid'},
    initial: SENT,
  },
  'failed-offline': {model: 'openai', answer: {status: 0}, initial: SENT},
  'made-model': {model: 'openai', cutout: 'model', initial: SENT},
  'made-erased': {model: 'openai', cutout: 'erased', initial: SENT},
  'made-unchanged': {model: 'openai', cutout: 'unchanged', initial: SENT},
  'made-caricature': {
    model: 'openai',
    initial: {...SENT, branch: CARICATURE},
  },
};

const ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const isPhotoModelPath = (path: string) =>
  path.endsWith('/expressions/photo-model');
const isPhotoDraftPath = (path: string) =>
  path.endsWith('/expressions/photo-drafts');

/** 코어 가짜 서버 + 이 장면이 바꾸는 것. 같은 포트(`ExpressionTransport`)라 폼은 진짜 서버와 같은 길로 부른다. */
export function createPhotoSceneTransport(
  scene: PhotoScene,
  nowMs: number = Date.now(),
): ExpressionTransport {
  const server = createExpressionFixtureServer({
    nowMs,
    photoModel: scene.model,
    photoFailure: scene.failure,
  });
  const waitUntilAbort = (request: ExpressionRequest) =>
    new Promise<never>((_, reject) => {
      request.signal?.addEventListener('abort', () =>
        reject(new Error('Expression photo request aborted')),
      );
    });
  return {
    async request(request): Promise<ExpressionFixtureResponse> {
      if (request.method === 'GET' && isPhotoModelPath(request.path)) {
        if (scene.check === 'pending') return new Promise<never>(() => {});
        if (typeof scene.check === 'number') {
          return {status: scene.check, json: {error: {}}};
        }
        if (scene.check) {
          return {
            status: scene.check.status,
            json: {error: {code: scene.check.code}},
          };
        }
        const response = server.request(request);
        const body = response.json as {canManage?: boolean} | undefined;
        return response.status === 200 && scene.canManage !== undefined
          ? {...response, json: {...body, canManage: scene.canManage}}
          : response;
      }
      if (request.method === 'POST' && isPhotoDraftPath(request.path)) {
        if (scene.hold) return waitUntilAbort(request);
        if (scene.answer?.status === 0) {
          throw new Error('Expression photo transport is offline');
        }
        if (scene.answer) {
          const code =
            scene.answer.code && ERROR_CODE.test(scene.answer.code)
              ? scene.answer.code
              : undefined;
          return {
            status: scene.answer.status,
            json: code ? {error: {code}} : {error: {}},
          };
        }
        const response = server.request(request);
        const body = response.json as object | undefined;
        return response.status === 201 && scene.cutout !== undefined
          ? {...response, json: {...body, cutout: scene.cutout}}
          : response;
      }
      return server.request(request);
    },
  };
}

function base64Of(bytes: Uint8Array): string {
  let text = '';
  bytes.forEach(byte => {
    text += String.fromCharCode(byte);
  });
  return btoa(text);
}
/** 미리보기 그림은 임시 파일 대신 `data:` 주소로 서서, 서버 없이도 `Image` 가 그린다. */
const FILES: ExpressionFiles = {
  write: (key, bytes) =>
    `data:${key.endsWith('.gif') ? 'image/gif' : 'image/png'};base64,${base64Of(
      bytes,
    )}`,
  remove: () => {},
};

// 공장은 모듈 값이다: 렌더마다 새 공장이면 provider 가 사전을 다시 읽는다.
const koController = () =>
  createMobileLocaleController({
    port: {
      readPreference: () => 'ko-KR',
      writePreference: () => {},
      readDevice: () => ({languages: ['ko-KR'], timeZone: 'Asia/Seoul'}),
    },
  });
const enController = () =>
  createMobileLocaleController({
    port: {
      readPreference: () => 'en-US',
      writePreference: () => {},
      readDevice: () => ({languages: ['en-US'], timeZone: 'Asia/Seoul'}),
    },
  });

const noop = () => {};

export function ExpressionPhotoSurface({
  which,
}: {
  which: string;
}): React.JSX.Element {
  const english = which.endsWith('-en');
  const scene = PHOTO_SCENES[english ? which.slice(0, -3) : which] ?? PHOTO_SCENES.form;
  const store = useMemo(
    () =>
      createPhoneExpressionStore(
        FIXTURE_WORKSPACE_ID,
        FIXTURE_MEMBER_ID,
        createPhotoSceneTransport(scene),
        FILES,
      ),
    [scene],
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
          <PageSheet
            height="large"
            onClose={noop}
            accessibilityLabel="expression-photo"
            testID="expressionphoto-sheet">
            <ExpressionPhotoForm
              onBack={noop}
              onImport={noop}
              onAgent={noop}
              onDone={noop}
              dev={{initial: scene.initial}}
            />
          </PageSheet>
        </PhoneExpressions.Provider>
      </Backdrop>
    </MobileLocaleProvider>
  );
}
